#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { printf "${CYAN}[tidecloak]${NC} %s\n" "$1"; }
ok()   { printf "${GREEN}[tidecloak]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}[tidecloak]${NC} %s\n" "$1"; }
err()  { printf "${RED}[tidecloak]${NC} %s\n" "$1"; }

# ─── Prerequisite checks ───

MISSING=0

check_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Missing required command: $1"
    if [ -n "${2:-}" ]; then printf "       Install: ${CYAN}%s${NC}\n" "$2"; fi
    MISSING=1
  fi
}

check_cmd docker "https://docs.docker.com/get-docker/"
check_cmd bash   "sudo apt install bash"
check_cmd curl   "sudo apt install curl"
check_cmd jq     "sudo apt install jq"

if [ "$MISSING" -ne 0 ]; then
  err "Fix the above issues and re-run."
  exit 1
fi

# Check Docker daemon is running
if ! sudo docker info >/dev/null 2>&1; then
  err "Docker is installed but the service isn't running."
  printf "       Start it with: ${CYAN}sudo systemctl start docker${NC}\n"
  exit 1
fi

ok "All prerequisites satisfied."

# ─── Start TideCloak container ───

log "Starting TideCloak container..."
sudo docker run \
 --name mytidecloak \
 -d \
 -v .:/opt/keycloak/data/h2 \
 -p 8080:8080 \
 -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
 -e KC_BOOTSTRAP_ADMIN_PASSWORD=password \
 -e KC_HOSTNAME=http://localhost:8080 \
 -e SYSTEM_HOME_ORK=https://sork1.tideprotocol.com \
 -e USER_HOME_ORK=https://sork1.tideprotocol.com \
 -e THRESHOLD_T=3 \
 -e THRESHOLD_N=5 \
 -e PAYER_PUBLIC=20000011d6a0e8212d682657147d864b82d10e92776c15ead43dcfdc100ebf4dcfe6a8 \
 tideorg/tidecloak-stg-dev:latest

# ─── Wait for TideCloak to be ready ───

export TIDECLOAK_LOCAL_URL=http://localhost:8080
log "Waiting for TideCloak to be ready..."
until curl -sf "$TIDECLOAK_LOCAL_URL" > /dev/null 2>&1; do
  sleep 2
done
ok "TideCloak is ready."

# ─── Initialize realm ───

mkdir -p "${PROJECT_ROOT}/data"
cd "$SCRIPT_DIR"
bash ./tcinit.sh
