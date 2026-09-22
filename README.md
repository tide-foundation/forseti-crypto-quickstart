# Forseti Crypto Quickstart

A hands-on demo app that walks you through policy-controlled encryption and decryption using Forseti smart contracts on the Tide network. Build a policy, commit it to the ORK nodes, then encrypt and decrypt data - all governed by rules you define in C#.

This project is designed as a starting point for developers who want to integrate Forseti into their own apps. Clone it, run the setup, and you'll have a working example of identity-based cryptographic access control in minutes.

## What is Forseti?

Forseti is an authorisation engine that executes C# smart contracts on the **Tide ORK network** to make allow or deny decisions at the cryptographic level. Every encryption or decryption request must include a contract. Without a valid contract, the request is denied.

Contracts are compiled from C# source via Roslyn, IL-vetted to block unsafe operations, and executed in a sandboxed process on every ORK node independently. This makes the allow/deny decision deterministic and tamper-proof. No single party, not even the app developer, can bypass the rules.

## What is a Policy?

A policy binds a Forseti contract to a set of runtime parameters and governs how it is enforced. A policy includes:

- **Contract ID** - the SHA-512 hash identifying which contract to run
- **Execution type** - `PRIVATE` means the contract checks the executor's identity and roles
- **Approval type** - `IMPLICIT` (no approver checks) or `EXPLICIT` (contract verifies approvers)
- **Parameters** - runtime values like role names, passed to the contract via `[PolicyParam]` attributes

### Policy Lifecycle

1. **Create** - configure the contract parameters (role restrictions, etc.)
2. **Approve** - an admin reviews and signs off on the policy
3. **Commit** - the approved policy is committed to the Tide ORK network, where the contract is compiled and stored
4. **Enforce** - every subsequent encrypt/decrypt request is evaluated by the contract on each ORK node

### Tags

Tags are string labels attached to encrypted data at encryption time. They travel with the ciphertext and are available to the contract during both encryption and decryption. Contracts can read tags to enforce rules. For example, a `DecryptTimeLock:{epoch}` tag tells the contract to block decryption until the specified time.

### Validation Stages

Contracts can implement up to three validation methods:

| Stage | When it runs | What it checks |
|---|---|---|
| `ValidateData` | Always | Request type, tags, time locks, payload constraints |
| `ValidateApprovers` | When approval is `EXPLICIT` | Quorum counts, roles of approvers |
| `ValidateExecutor` | When execution is `PRIVATE` | Identity and roles of the person performing the action |

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/)
- [Node.js](https://nodejs.org/) >= 20.9.0
- `bash`, `curl` and `jq` (used by the init script)

## Getting Started

### 0. Clone the repo

```bash
git clone https://github.com/tide-foundation/forseti-crypto-quickstart.git
cd forseti-crypto-quickstart/template-ts-app
```

### 1. Initialize TideCloak

Run the init script to start a TideCloak container, create a realm, and configure an admin user:

```bash
npm run init
```

This will:

- Start a TideCloak Docker container on port `8080`
- Create the `forseti-test` realm with a pre-configured client
- Enable IGA (Identity Governance & Administration)
- Create an admin user and generate an invite link
- Prompt you for a license email and Terms & Conditions acceptance
- Save the adapter config to `data/tidecloak.json`
- Save the signed admin policy to `data/admin-policy.b64`

**Important:** When the invite link appears, open it in your browser to link the admin account. The script waits until the account is linked, then finishes provisioning.

The admin policy snapshot is what the app attaches to every Forseti policy it commits. If you add more admins later, or the admin policy is regenerated, refresh both data files without touching the realm or the container:

```bash
EXPORT_ONLY=1 bash init/tcinit.sh
```

(`npm run init` would try to start a new container, so call the script directly here.)

To start over, remove the container and its data first. The init script refuses to run against an existing realm:

```bash
sudo docker rm -f mytidecloak
sudo rm -f keycloakdb.mv.db keycloakdb.trace.db
rm -rf db data/tidecloak.json data/admin-policy.b64
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Start the App

```bash
npm run dev
```

The app will be available at [http://localhost:3000](http://localhost:3000).

## Usage

1. **Log in** with TideCloak using the linked admin account
2. **Create a Forseti policy** - configure role-based encryption/decryption restrictions and optional time locks
3. **Review & approve** the policy as an admin
4. **Commit** the approved policy to the Tide ORK network
5. **Tag & encrypt** data - attach tags (including time locks) to your encrypted payload
6. **Decrypt** data - the Forseti contract checks roles, tags, and time locks before allowing decryption

On Chrome 142 and later, the enclave iframe's first call to a TideCloak on localhost triggers an "allow access to local network" prompt. Accept it. If the first Create then times out with `TIDE-TIDEJS-NET-TIMEOUT`, click Create again; the second attempt goes through.

If port 8080 is already taken, run the container on another port and set `TIDECLOAK_LOCAL_URL` (and the container's `KC_HOSTNAME`) to match.

## The Default Contract

The included contract (`lib/forsetiContract.ts`) supports:

- **Role-based encryption** - restrict who can encrypt via `EncryptionRealmRole` parameter
- **Role-based decryption** - restrict who can decrypt via `DecryptionRealmRole` parameter
- **Tag-based time locks** - reads `DecryptTimeLock:{epoch}` tags from the encrypted data to block decryption before a specific time

The contract is editable in the app's sidebar. Any change updates the contract ID (SHA-512 hash) in real time, so you can experiment with custom logic.

## Configuration

The init script uses defaults from `init/.env.example`:

| Variable | Default | Description |
|---|---|---|
| `TIDECLOAK_LOCAL_URL` | `http://localhost:8080` | TideCloak server URL |
| `CLIENT_NAME` | `myclient` | OIDC client name |
| `CLIENT_APP_URL` | `http://localhost:3000` | App URL (for CORS/redirects) |
| `NEW_REALM_NAME` | `forseti-test` | TideCloak realm name |
| `KC_USER` | `admin` | TideCloak admin username |
| `KC_PASSWORD` | `password` | TideCloak admin password |

## Project Structure

```
template-ts-app/
  app/              Next.js app routes
    home/            Main page (policy creation, encrypt/decrypt)
    api/policies/    Policy CRUD API
  components/        AuthProvider with TideCloak integration
  hooks/             useAuth hook
  init/              TideCloak setup scripts
    start.sh         Container + init entrypoint
    tcinit.sh        Realm configuration
    realm.json       Realm template
  lib/
    forsetiContract.ts   Default Forseti C# contract
    database/            SQLite policy storage
  data/              Generated adapter config and admin policy snapshot
```
