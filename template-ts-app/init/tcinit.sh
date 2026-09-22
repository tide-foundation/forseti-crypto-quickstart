#!/usr/bin/env bash
set -euo pipefail

# Provisions the Forseti quickstart realm on a TideCloak server.
# Ported from @tidecloak/create-nextjs tcinit.sh and driven by the current
# iga-core change-request API. Writes data/tidecloak.json (adapter config)
# and data/admin-policy.b64 (signed admin policy snapshot).
#
# Run from anywhere:  bash init/tcinit.sh

SCRIPT_DIR="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." >/dev/null 2>&1 && pwd -P)"

# --- Colors & logging -------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { printf "${CYAN}[tidecloak]${NC} %s\n" "$1"; }
ok()   { printf "${GREEN}[tidecloak]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[tidecloak]${NC} %s\n" "$1"; }
err()  { printf "${RED}[tidecloak]${NC} %s\n" "$1" >&2; }

# --- Load defaults from .env.example (project root first, then init/) -------
# Values already set in the environment win. The file is parsed, not sourced,
# so caller-supplied env (e.g. from create.ts) is never overridden.
load_env_file() {
  local file="$1"
  [[ -f "$file" ]] || return 0
  while IFS= read -r _env_line || [[ -n "$_env_line" ]]; do
    _env_line="${_env_line%$'\r'}"
    if [[ "$_env_line" =~ ^[[:space:]]*(#|$) ]]; then
      continue
    fi
    if [[ "$_env_line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      _env_key="${BASH_REMATCH[2]}"
      _env_val="${BASH_REMATCH[3]}"
      _env_val="${_env_val#"${_env_val%%[![:space:]]*}"}"
      _env_val="${_env_val%"${_env_val##*[![:space:]]}"}"
      if [[ ${#_env_val} -ge 2 && "$_env_val" == \"*\" ]]; then
        _env_val="${_env_val:1:${#_env_val}-2}"
      elif [[ ${#_env_val} -ge 2 && "$_env_val" == \'*\' ]]; then
        _env_val="${_env_val:1:${#_env_val}-2}"
      fi
      if [[ -z "${!_env_key:-}" ]]; then
        printf -v "$_env_key" '%s' "$_env_val"
      fi
    fi
  done < "$file"
  unset _env_line _env_key _env_val
}
load_env_file "${PROJECT_ROOT}/.env.example"
load_env_file "${SCRIPT_DIR}/.env.example"

# --- Defaults (override via env) --------------------------------------------
TIDECLOAK_LOCAL_URL="${TIDECLOAK_LOCAL_URL:-http://localhost:8080}"
CLIENT_APP_URL="${CLIENT_APP_URL:-http://localhost:3000}"
NEW_REALM_NAME="${NEW_REALM_NAME:-forseti-test}"
REALM_MGMT_CLIENT_ID="${REALM_MGMT_CLIENT_ID:-realm-management}"
ADMIN_ROLE_NAME="${ADMIN_ROLE_NAME:-tide-realm-admin}"
KC_USER="${KC_USER:-admin}"
KC_PASSWORD="${KC_PASSWORD:-password}"
CLIENT_NAME="${CLIENT_NAME:-myclient}"
ADAPTER_OUTPUT_PATH="${ADAPTER_OUTPUT_PATH:-${PROJECT_ROOT}/data/tidecloak.json}"
ADMIN_POLICY_OUTPUT_PATH="${ADMIN_POLICY_OUTPUT_PATH:-${PROJECT_ROOT}/data/admin-policy.b64}"
MARKER_DIR="${SCRIPT_DIR}"

# --- Prompt for license email + terms (skipped when SUBSCRIPTION_EMAIL is set)
if [[ -z "${SUBSCRIPTION_EMAIL:-}" ]]; then
  if [[ ! -t 0 ]]; then
    err "SUBSCRIPTION_EMAIL is not set and stdin is not a terminal. Set SUBSCRIPTION_EMAIL and re-run."
    exit 1
  fi
  echo ""
  while true; do
    printf "${YELLOW}Enter an email to manage your license: ${NC}"
    read -r SUBSCRIPTION_EMAIL
    case "$SUBSCRIPTION_EMAIL" in
      ?*@?*.?*) break ;;
      *) err "Please enter a valid email address" ;;
    esac
  done

  echo ""
  echo "Please review the Terms & Conditions at: https://tide.org/legal"
  while true; do
    printf "${YELLOW}I agree to the Terms & Conditions (enter 'y' or 'yes' to continue): ${NC}"
    read -r TERMS_ACCEPTANCE
    case "$TERMS_ACCEPTANCE" in
      y|yes) break ;;
      *) err "You must explicitly agree to the Terms & Conditions by entering 'y' or 'yes'" ;;
    esac
  done
  echo ""
fi

# --- Find realm.json --------------------------------------------------------
CANDIDATES=()
[[ "${REALM_JSON_PATH:-}" != "" ]] && CANDIDATES+=("${REALM_JSON_PATH}")
CANDIDATES+=("${SCRIPT_DIR}/realm.json" "${SCRIPT_DIR}/../realm.json" "$(pwd)/realm.json")

REALM_JSON_PATH=""
for p in "${CANDIDATES[@]}"; do
  if [[ -f "$p" ]]; then REALM_JSON_PATH="$p"; break; fi
done

if [[ -z "${REALM_JSON_PATH}" ]]; then
  err "Could not find realm.json in:"
  for p in "${CANDIDATES[@]}"; do echo "   - $p" >&2; done
  echo "   Put realm.json next to the script (${SCRIPT_DIR}/realm.json)" >&2
  echo "   OR run with: REALM_JSON_PATH=/abs/path/realm.json bash init/tcinit.sh" >&2
  exit 1
fi
log "Using realm.json: ${REALM_JSON_PATH}"

# --- Dependency checks ------------------------------------------------------
need_cmd() { command -v "$1" >/dev/null 2>&1 || { err "Missing dependency: $1"; exit 1; }; }
need_cmd curl
need_cmd jq
need_cmd sed
need_cmd mktemp
need_cmd base64

# --- sed -i portability -----------------------------------------------------
if sed --version >/dev/null 2>&1; then SED_INPLACE=(-i); else SED_INPLACE=(-i ''); fi

# --- Cleanup handler --------------------------------------------------------
# INCOMPLETE_FIRSTADMIN is 1 between enabling IGA and the final grant+flip.
# A non-zero exit in that window leaves the realm half-provisioned; warn.
TMP_REALM_JSON=""
INCOMPLETE_FIRSTADMIN=0
cleanup() {
  local rc=$?
  [[ -n "${TMP_REALM_JSON}" && -f "${TMP_REALM_JSON}" ]] && rm -f "${TMP_REALM_JSON}" || true
  [[ -f "${MARKER_DIR}/.realm_name" ]] && rm -f "${MARKER_DIR}/.realm_name" || true
  if [[ "${rc}" != "0" && "${INCOMPLETE_FIRSTADMIN}" == "1" ]]; then
    echo "" >&2
    err "WARNING: realm '${REALM_NAME:-?}' may be left in an incomplete firstAdmin"
    err "         state (IGA enabled, admin not yet granted/flipped)."
    err "         Complete provisioning or delete the realm before use."
  fi
}
trap cleanup EXIT

# --- Plaintext-to-remote credential warning (non-fatal) ---------------------
case "${TIDECLOAK_LOCAL_URL}" in
  http://localhost|http://localhost:*|http://localhost/*)   : ;;
  http://127.0.0.1|http://127.0.0.1:*|http://127.0.0.1/*)   : ;;
  http://\[::1\]|http://\[::1\]:*|http://\[::1\]/*)         : ;;
  http://*)
    warn "TIDECLOAK_LOCAL_URL='${TIDECLOAK_LOCAL_URL}' uses cleartext http:// to a non-loopback host."
    warn "Admin credentials and bearer tokens will be sent UNENCRYPTED over the network."
    ;;
esac

# --- Helper: fresh master admin-cli token -----------------------------------
get_admin_token() {
  curl -s -X POST "${TIDECLOAK_LOCAL_URL}/realms/master/protocol/openid-connect/token" \
       -H "Content-Type: application/x-www-form-urlencoded" \
       -d "username=${KC_USER}" \
       -d "password=${KC_PASSWORD}" \
       -d "grant_type=password" \
       -d "client_id=admin-cli" \
    | jq -r .access_token
}

# --- Helper: status-capturing admin API call --------------------------------
# Usage: api METHOD URL [extra curl args...]
# Sets RESP_CODE and RESP_BODY in the current shell. Call it directly, not
# inside $(...), or the globals are lost. Adds the bearer header itself.
RESP_CODE=""
RESP_BODY=""
api() {
  local method="$1" url="$2"; shift 2
  local tmp
  tmp="$(mktemp)"
  RESP_CODE=$(curl -s -o "${tmp}" -w "%{http_code}" -X "${method}" "${url}" \
           -H "Authorization: Bearer ${TOKEN}" "$@") || RESP_CODE="000"
  RESP_BODY="$(cat "${tmp}")"
  rm -f "${tmp}"
}

# --- Drain PENDING IGA change-requests --------------------------------------
# /approve records and auto-commits at threshold 1. Loop until the inbox is
# empty because approving one CR unblocks its dependents.
drain_change_requests() {
  local label="${1:-}" rounds=0
  log "Draining PENDING change-requests ${label}..."
  while (( rounds < 12 )); do
    TOKEN="$(get_admin_token)"
    local list_tmp list_code
    list_tmp="$(mktemp)"
    list_code=$(curl -s -o "${list_tmp}" -w "%{http_code}" \
      "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/iga/change-requests?status=PENDING" \
      -H "Authorization: Bearer ${TOKEN}" -H "Cache-Control: no-store") || list_code="000"
    if [[ "${list_code}" == "401" || "${list_code}" == "403" ]]; then
      rm -f "${list_tmp}"
      err "FATAL: change-request LIST returned HTTP ${list_code} ${label}. Admin authentication/authorization failed."
      err "       Check KC_USER/KC_PASSWORD and admin privileges."
      exit 1
    fi
    ids=$(jq -r '.[].id // empty' < "${list_tmp}")
    rm -f "${list_tmp}"
    if [[ -z "${ids}" ]]; then ok "  inbox empty ${label}"; return 0; fi
    while IFS= read -r id; do
      [[ -z "$id" ]] && continue
      st=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
        "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/iga/change-requests/${id}/approve" \
        -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" -d '{}')
      case "$st" in
        2*) : ;;
        401|403)
          err "FATAL: change-request approve ${id} returned HTTP ${st} ${label}. Admin authentication/authorization failed."
          exit 1 ;;
        404|409|412) : ;;
        *) warn "  approve ${id} -> ${st}" ;;
      esac
    done <<< "${ids}"
    ((rounds++)) || true
  done
  warn "  drain hit round cap ${label}"; return 0
}

# ============================================================================
#  Step 1: prepare realm JSON + create the realm
# ============================================================================
REALM_NAME="${NEW_REALM_NAME}"
echo "${REALM_NAME}" > "${MARKER_DIR}/.realm_name"
mkdir -p "${PROJECT_ROOT}/data"

TMP_REALM_JSON="$(mktemp)"
cp "${REALM_JSON_PATH}" "${TMP_REALM_JSON}"

sed "${SED_INPLACE[@]}" "s|http://localhost:3000|${CLIENT_APP_URL}|g" "${TMP_REALM_JSON}"
sed "${SED_INPLACE[@]}" "s|forseti-test|${REALM_NAME}|g"              "${TMP_REALM_JSON}"
sed "${SED_INPLACE[@]}" "s|myclient|${CLIENT_NAME}|g"                 "${TMP_REALM_JSON}"

log "Creating realm '${REALM_NAME}'..."
TOKEN="$(get_admin_token)"
api POST "${TIDECLOAK_LOCAL_URL}/admin/realms" \
  -H "Content-Type: application/json" \
  --data-binary @"${TMP_REALM_JSON}"
code="${RESP_CODE}"
if [[ "${code}" == 2* ]]; then
  ok "  realm create -> ${code} (created)"
elif [[ "${code}" == "409" ]]; then
  if [[ "${ALLOW_EXISTING_REALM:-}" == "1" ]]; then
    warn "Realm '${REALM_NAME}' already exists (HTTP 409); ALLOW_EXISTING_REALM=1 set, proceeding."
    warn "The drain step approves ALL pending change-requests in this realm."
  else
    err "Realm '${REALM_NAME}' already exists. This script provisions FRESH realms."
    err "Remove the container and its data, or set ALLOW_EXISTING_REALM=1 to override."
    exit 1
  fi
else
  err "Realm creation failed (HTTP ${code})"
  err "${RESP_BODY}"
  exit 1
fi

# ============================================================================
#  Step 2: setUpTideRealm (VRK keygen on the Tide network, needs healthy ORKs)
# ============================================================================
log "Setting up Tide realm (VRK keygen on the Tide network)..."
TOKEN="$(get_admin_token)"
api POST "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/vendorResources/setUpTideRealm" \
  --max-time 300 \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "email=${SUBSCRIPTION_EMAIL}" \
  --data-urlencode "isRagnarokEnabled=true" \
  --data-urlencode "skipLicense=false"
code="${RESP_CODE}"
if [[ "${code}" != 2* ]]; then
  err "setUpTideRealm failed (HTTP ${code})."
  err "Check that the ORKs are reachable and the license email is valid."
  err "Response: ${RESP_BODY}"
  exit 1
fi
ok "  setUpTideRealm -> ${code}"

# ============================================================================
#  Step 3: stamp iga.attestor=tide on the realm before enabling IGA
# ============================================================================
log "Stamping iga.attestor=tide on the realm..."
TOKEN="$(get_admin_token)"
api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}"
code="${RESP_CODE}"
if [[ "${code}" != 2* ]]; then
  err "Could not fetch realm representation (HTTP ${code})."
  err "Response: ${RESP_BODY}"
  exit 1
fi
REALM_REP_FILE="$(mktemp)"
jq '.attributes = ((.attributes // {}) + {"iga.attestor":"tide"})' <<< "${RESP_BODY}" > "${REALM_REP_FILE}"
TOKEN="$(get_admin_token)"
api PUT "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}" \
  -H "Content-Type: application/json" \
  --data-binary @"${REALM_REP_FILE}"
code="${RESP_CODE}"
rm -f "${REALM_REP_FILE}"
if [[ "${code}" != 2* ]]; then
  err "Failed to set iga.attestor=tide (HTTP ${code})."
  err "Response: ${RESP_BODY}"
  exit 1
fi
ok "  iga.attestor=tide -> ${code}"

# ============================================================================
#  Step 4: check IGA status, then enable it if needed
#  toggle-iga is a pure flip, so never call it on an already-enabled realm.
# ============================================================================
log "Checking IGA status..."
TOKEN="$(get_admin_token)"
api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/tide-admin/iga-status"
code="${RESP_CODE}"
if [[ "${code}" != 2* ]]; then
  err "iga-status failed (HTTP ${code})."
  err "Response: ${RESP_BODY}"
  exit 1
fi
IGA_ENABLED="$(jq -r '.enabled // false' <<< "${RESP_BODY}")"

if [[ "${IGA_ENABLED}" == "true" ]]; then
  warn "  IGA already enabled; skipping toggle."
else
  log "Enabling IGA governance (this runs an ORK ceremony and can take a while)..."
  TOKEN="$(get_admin_token)"
  api POST "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/tide-admin/toggle-iga" \
    --max-time 300 \
    -H "Content-Type: application/x-www-form-urlencoded" \
    --data-urlencode "isIGAEnabled=true"
  code="${RESP_CODE}"
  if [[ "${code}" != 2* ]]; then
    err "toggle-iga failed (HTTP ${code})."
    err "Response: ${RESP_BODY}"
    exit 1
  fi

  # Inspect the body. A failed ORK ceremony can still come back as 200.
  TOGGLE_ENABLED="$(jq -r '.enabled // false' <<< "${RESP_BODY}")"
  TOGGLE_WARNINGS="$(jq -c '.warnings // null' <<< "${RESP_BODY}")"
  TOGGLE_WARNING="$(jq -r '.warning // empty' <<< "${RESP_BODY}")"
  TOGGLE_RAN="$(jq -r '.autoCommit.ran // false' <<< "${RESP_BODY}")"
  TOGGLE_REJECTED="$(jq -r '.autoCommit.rejected // 0' <<< "${RESP_BODY}")"
  TOGGLE_SKIP="$(jq -r '.autoCommit.skipReason // empty' <<< "${RESP_BODY}")"

  [[ -n "${TOGGLE_WARNING}" ]] && warn "  toggle-iga warning: ${TOGGLE_WARNING}"
  [[ -n "${TOGGLE_SKIP}" ]] && warn "  toggle-iga autoCommit skipReason: ${TOGGLE_SKIP}"

  if [[ "${TOGGLE_ENABLED}" != "true" || "${TOGGLE_WARNINGS}" != "null" \
        || "${TOGGLE_RAN}" != "true" || "${TOGGLE_REJECTED}" != "0" ]]; then
    err "toggle-iga returned HTTP ${code} but the result is not clean."
    err "  enabled=${TOGGLE_ENABLED} autoCommit.ran=${TOGGLE_RAN} autoCommit.rejected=${TOGGLE_REJECTED}"
    err "  warningsSummary: $(jq -r '.warningsSummary // "none"' <<< "${RESP_BODY}")"
    err "  Response: ${RESP_BODY}"
    exit 1
  fi
  ok "  toggle-iga -> ${code} (IGA enabled)"

  TOKEN="$(get_admin_token)"
  api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/tide-admin/iga-status"
  if [[ "${RESP_CODE}" != 2* || "$(jq -r '.enabled // false' <<< "${RESP_BODY}")" != "true" ]]; then
    err "IGA does not report enabled after toggle (HTTP ${RESP_CODE})."
    err "Response: ${RESP_BODY}"
    exit 1
  fi
fi

# From here until the final grant+flip the realm is half-provisioned.
INCOMPLETE_FIRSTADMIN=1

# ============================================================================
#  Step 5: drain the ADOPT change-requests raised by enabling IGA
# ============================================================================
drain_change_requests "(after IGA enable)"

# ============================================================================
#  Step 6: create the admin user (tideInvitable so it can be invited later)
# ============================================================================
log "Creating admin user..."
TOKEN="$(get_admin_token)"
api POST "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/users" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","email":"admin@tidecloak.com","firstName":"Admin","lastName":"User","enabled":true,"emailVerified":false,"attributes":{"tideInvitable":["true"]}}'
code="${RESP_CODE}"
if [[ "${code}" == "202" ]]; then
  ok "  create user -> 202 (change-request parked)"
elif [[ "${code}" == 2* ]]; then
  ok "  create user -> ${code}"
elif [[ "${code}" == "409" ]]; then
  warn "  create user -> 409 (already exists)"
else
  err "Admin user creation failed (HTTP ${code})."
  err "Response: ${RESP_BODY}"
  exit 1
fi

# ============================================================================
#  Step 7: drain (commits CREATE_USER) before resolving the id
# ============================================================================
drain_change_requests "(after user create)"

# ============================================================================
#  Step 8: resolve the admin userId (non-empty proves the create committed)
# ============================================================================
log "Resolving admin userId..."
TOKEN="$(get_admin_token)"
api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/users?username=admin&exact=true"
code="${RESP_CODE}"
USER_ID="$(jq -r '.[0].id // empty' <<< "${RESP_BODY}")"
if [[ -z "${USER_ID}" ]]; then
  err "Could not resolve admin userId (HTTP ${code}); the CREATE_USER change-request may not have committed."
  err "Response: ${RESP_BODY}"
  exit 1
fi
ok "  admin userId = ${USER_ID}"

# ============================================================================
#  Step 9: mint the Tide enrollment link
# ============================================================================
log "Generating invite link..."
TOKEN="$(get_admin_token)"
api POST "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/tideAdminResources/get-required-action-link?userId=${USER_ID}&lifespan=43200" \
  -H "Content-Type: application/json" \
  -H "Accept: text/plain" \
  -d '["link-tide-account-action"]'
code="${RESP_CODE}"
if [[ "${code}" != 2* ]]; then
  err "Failed to mint enrollment link (HTTP ${code})."
  err "Response: ${RESP_BODY}"
  exit 1
fi
INVITE_LINK="${RESP_BODY}"

# ============================================================================
#  Step 10: wait for the human to enroll in the Tide enclave
# ============================================================================
echo ""
echo "----------------------------------------------------------------------"
echo "  ACTION REQUIRED: Open this URL and complete Tide enrollment:"
echo ""
echo "    ${INVITE_LINK}"
echo ""
echo "  Enrollment happens in the Tide enclave and can take a few minutes."
echo "  This script waits and continues automatically once you are enrolled."
echo "----------------------------------------------------------------------"
echo ""

poll_attempt=0
POLL_MAX=100000
while true; do
  poll_attempt=$(( poll_attempt + 1 ))
  TOKEN="$(get_admin_token)"
  ATTRS=$(curl -s "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/users?username=admin&exact=true&briefRepresentation=false" \
    -H "Authorization: Bearer ${TOKEN}" -H "Cache-Control: no-store")
  KEY=$(jq -r '.[0].attributes.tideUserKey[0] // empty' <<< "${ATTRS}")
  VUID=$(jq -r '.[0].attributes.vuid[0]        // empty' <<< "${ATTRS}")
  if [[ -n "${KEY}" && -n "${VUID}" ]]; then
    ok "  Tide enrollment detected (tideUserKey + vuid present)."
    break
  fi
  if (( poll_attempt >= POLL_MAX )); then
    err "Gave up waiting for Tide enrollment after ${poll_attempt} polls."
    exit 1
  fi
  printf "  waiting for enrollment... (poll %s)\r" "${poll_attempt}"
  sleep 4
done

# ============================================================================
#  Step 11: drain (safety net; enrollment writes normally bypass capture)
# ============================================================================
drain_change_requests "(after enrollment)"

# ============================================================================
#  Step 12: point the tide IdP at the app origin, then sign the settings
# ============================================================================
log "Signing tide IdP settings (CustomAdminUIDomain -> ${CLIENT_APP_URL})..."
TOKEN="$(get_admin_token)"
api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/identity-provider/instances/tide"
code="${RESP_CODE}"
if [[ "${code}" != 2* ]]; then
  err "Could not fetch tide IdP instance (HTTP ${code})."
  err "Response: ${RESP_BODY}"
  exit 1
fi
IDP_REP_FILE="$(mktemp)"
jq --arg d "${CLIENT_APP_URL}" '.config.CustomAdminUIDomain = $d' <<< "${RESP_BODY}" > "${IDP_REP_FILE}"
TOKEN="$(get_admin_token)"
api PUT "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/identity-provider/instances/tide" \
  -H "Content-Type: application/json" \
  --data-binary @"${IDP_REP_FILE}"
code="${RESP_CODE}"
rm -f "${IDP_REP_FILE}"
if [[ "${code}" != 2* ]]; then
  err "Failed to update tide IdP settings (HTTP ${code})."
  err "Response: ${RESP_BODY}"
  exit 1
fi
TOKEN="$(get_admin_token)"
api POST "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/vendorResources/sign-idp-settings" \
  -H "Content-Type: text/plain" \
  --data-binary ""
code="${RESP_CODE}"
if [[ "${code}" != 2* ]]; then
  err "sign-idp-settings failed (HTTP ${code}). Needs healthy ORKs."
  err "Response: ${RESP_BODY}"
  exit 1
fi
ok "  IdP settings signed -> ${code}"

# ============================================================================
#  Step 13: grant tide-realm-admin to the enrolled admin (last governed write)
# ============================================================================
log "Granting ${ADMIN_ROLE_NAME} to the admin user..."
TOKEN="$(get_admin_token)"
api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/clients?clientId=${REALM_MGMT_CLIENT_ID}"
code="${RESP_CODE}"
RM_UUID="$(jq -r '.[0].id // empty' <<< "${RESP_BODY}")"
if [[ -z "${RM_UUID}" ]]; then
  err "Could not resolve ${REALM_MGMT_CLIENT_ID} client uuid (HTTP ${code})."
  exit 1
fi
TOKEN="$(get_admin_token)"
api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/clients/${RM_UUID}/roles/${ADMIN_ROLE_NAME}"
code="${RESP_CODE}"
if [[ "${code}" != 2* ]]; then
  err "Could not fetch ${ADMIN_ROLE_NAME} role (HTTP ${code})."
  err "Response: ${RESP_BODY}"
  exit 1
fi
ROLE_REP="${RESP_BODY}"

TOKEN="$(get_admin_token)"
api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/users/${USER_ID}/role-mappings/clients/${RM_UUID}"
code="${RESP_CODE}"
ALREADY=$(jq -r --arg r "${ADMIN_ROLE_NAME}" '[.[]?.name] | index($r) // empty' <<< "${RESP_BODY}")
if [[ -n "${ALREADY}" ]]; then
  warn "  ${ADMIN_ROLE_NAME} already mapped; skipping grant."
else
  TOKEN="$(get_admin_token)"
  api POST "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/users/${USER_ID}/role-mappings/clients/${RM_UUID}" \
    -H "Content-Type: application/json" \
    -d "[${ROLE_REP}]"
  code="${RESP_CODE}"
  case "${code}" in
    202) ok "  grant -> 202 (change-request parked)" ;;
    2*)  ok "  grant -> ${code}" ;;
    409)
      warn "  grant -> 409; draining then retrying once..."
      drain_change_requests "(grant 409 retry)"
      TOKEN="$(get_admin_token)"
      api POST "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/users/${USER_ID}/role-mappings/clients/${RM_UUID}" \
        -H "Content-Type: application/json" \
        -d "[${ROLE_REP}]"
      code="${RESP_CODE}"
      case "${code}" in
        2*|409) ok "  grant retry -> ${code}" ;;
        *) err "Grant retry failed (HTTP ${code})."; err "${RESP_BODY}"; exit 1 ;;
      esac
      ;;
    *)   err "Grant failed (HTTP ${code})."; err "${RESP_BODY}"; exit 1 ;;
  esac
fi

# ============================================================================
#  Step 14: final drain. Commits GRANT_ROLES and flips firstAdmin -> multiAdmin.
#  Nothing governed may run after this; later approvals need the enclave.
# ============================================================================
drain_change_requests "(final: grant + firstAdmin->multiAdmin flip)"
INCOMPLETE_FIRSTADMIN=0

TOKEN="$(get_admin_token)"
api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/iga/change-requests?status=PENDING" \
  -H "Cache-Control: no-store"
if [[ "${RESP_CODE}" == 2* ]]; then
  LEFTOVER="$(jq -r '.[]? | "\(.id) \(.actionType // "?")"' <<< "${RESP_BODY}")"
  if [[ -n "${LEFTOVER}" ]]; then
    warn "Change-requests still PENDING after the final drain (approve them in the admin console):"
    while IFS= read -r line; do warn "  ${line}"; done <<< "${LEFTOVER}"
  fi
fi

# ============================================================================
#  Step 15: export the signed admin policy snapshot
#  The app attaches this to every Forseti policy request it commits.
# ============================================================================
log "Exporting admin policy snapshot..."
TOKEN="$(get_admin_token)"
api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/iga/role-policies/name/${ADMIN_ROLE_NAME}" \
  --max-time 60 -H "Cache-Control: no-store"
code="${RESP_CODE}"
if [[ "${code}" != 2* ]]; then
  err "Could not fetch the ${ADMIN_ROLE_NAME} policy (HTTP ${code})."
  err "Response: ${RESP_BODY}"
  exit 1
fi
POLICY_B64="$(jq -r '.policy // empty' <<< "${RESP_BODY}")"
POLICY_SIG="$(jq -r '.policySig // empty' <<< "${RESP_BODY}")"
POLICY_CONTRACT="$(jq -r '.contractId // "?"' <<< "${RESP_BODY}")"
POLICY_THRESHOLD="$(jq -r '.threshold // "?"' <<< "${RESP_BODY}")"

if [[ -z "${POLICY_B64}" ]]; then
  err "The ${ADMIN_ROLE_NAME} policy record has no policy bytes."
  err "Response: ${RESP_BODY}"
  exit 1
fi
if [[ "${POLICY_B64}" == \{* || "${POLICY_SIG}" == TIDE-DUMMY-v1:* ]]; then
  err "The ${ADMIN_ROLE_NAME} policy is an unsigned stub. The realm is not signing-capable"
  err "(check THRESHOLD_T/THRESHOLD_N and the vendor key). Response: ${RESP_BODY}"
  exit 1
fi
if ! printf '%s' "${POLICY_B64}" | base64 -d >/dev/null 2>&1; then
  err "The ${ADMIN_ROLE_NAME} policy is not valid base64."
  err "Response: ${RESP_BODY}"
  exit 1
fi
printf '%s' "${POLICY_B64}" > "${ADMIN_POLICY_OUTPUT_PATH}"
ok "  admin policy saved to ${ADMIN_POLICY_OUTPUT_PATH} (contractId=${POLICY_CONTRACT} threshold=${POLICY_THRESHOLD})"

# ============================================================================
#  Step 16: fetch the client adapter config (tidecloak.json)
# ============================================================================
log "Fetching adapter config..."
TOKEN="$(get_admin_token)"
api GET "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/clients?clientId=${CLIENT_NAME}"
code="${RESP_CODE}"
CLIENT_UUID="$(jq -r '.[0].id // empty' <<< "${RESP_BODY}")"
if [[ -z "${CLIENT_UUID}" ]]; then
  err "Could not resolve client '${CLIENT_NAME}' uuid (HTTP ${code})."
  exit 1
fi
TOKEN="$(get_admin_token)"
adapter_code=$(curl -s -o "${ADAPTER_OUTPUT_PATH}" -w "%{http_code}" \
  "${TIDECLOAK_LOCAL_URL}/admin/realms/${REALM_NAME}/vendorResources/get-installations-provider?clientId=${CLIENT_UUID}&providerId=keycloak-oidc-keycloak-json" \
  -H "Authorization: Bearer ${TOKEN}")
if [[ "${adapter_code}" != 2* ]]; then
  err "Failed to fetch adapter config (HTTP ${adapter_code})."
  err "$(cat "${ADAPTER_OUTPUT_PATH}" 2>/dev/null)"
  rm -f "${ADAPTER_OUTPUT_PATH}"
  exit 1
fi

if ! jq -e --arg o "client-origin-auth-${CLIENT_APP_URL}" \
     '.vendorId and .homeOrkUrl and .jwk.keys[0].x and .[$o]' "${ADAPTER_OUTPUT_PATH}" >/dev/null 2>&1; then
  err "Adapter config is missing vendorId, homeOrkUrl, jwk or client-origin-auth-${CLIENT_APP_URL}."
  err "$(cat "${ADAPTER_OUTPUT_PATH}")"
  exit 1
fi
ok "  Adapter config saved to ${ADAPTER_OUTPUT_PATH}"

echo ""
ok "All done. Realm '${REALM_NAME}' is provisioned and the first admin is enrolled."
ok "If you add admins later, re-run this export to refresh data/admin-policy.b64."
