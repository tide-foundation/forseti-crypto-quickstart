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

- [Docker](https://docs.docker.com/get-docker/) (the init script runs `sudo docker`)
- [Node.js](https://nodejs.org/) 20.9 or newer (`.nvmrc` says 22)
- `bash`, `curl`, `jq` and `base64` (used by the init script)
- A Chromium-based browser or Firefox

## Getting Started

### 0. Clone the repo

```bash
git clone https://github.com/tide-foundation/forseti-crypto-quickstart.git
cd forseti-crypto-quickstart/template-ts-app
```

### 1. Initialize TideCloak

```bash
npm run init
```

This asks for a license email and Terms & Conditions acceptance, starts a `mytidecloak` TideCloak container on port `8080`, creates the `forseti-test` realm with its client, enables IGA, creates an admin user, then prints an enrolment link and waits.

**Important:** Open the enrolment link in your browser and create or sign in to a Tide account. The script continues once the account is linked and finishes with "All done".

Init produces two files:

- `data/tidecloak.json`: the adapter config the app uses to talk to TideCloak.
- `data/admin-policy.b64`: the realm's signed admin policy. The app attaches it to every new Forseti policy so the network will accept it.

### 2. Install and start the app

```bash
npm install && npm run dev
```

The app will be available at [http://localhost:3000](http://localhost:3000).

## Usage

1. **Log in** with TideCloak using the account you just enrolled
2. **Create a Forseti policy** - configure role-based encryption/decryption restrictions and optional time locks
3. **Review & approve** the policy as an admin (approve in the enclave popup)
4. **Commit** the approved policy to the Tide ORK network
5. **Tag & encrypt** data - attach tags (including time locks) to your encrypted payload
6. **Decrypt** data - the Forseti contract checks roles, tags, and time locks before allowing decryption

## Things you will hit

- On the first Create, Chrome 142 and later asks whether the enclave may reach your local network. Accept it. If Create then times out with `TIDE-TIDEJS-NET-TIMEOUT`, click Create again.
- The sign-in inside the enrolment link times out after about five minutes. If that happens, open the same link again and sign in again.
- Port 8080 already in use: `npm run init` pins the container to 8080. Start the container yourself on another port with `KC_HOSTNAME` set to match, then run `TIDECLOAK_LOCAL_URL=http://localhost:<port> bash init/tcinit.sh`.
- Running init again while the `forseti-test` realm exists is refused. Use the start-over block below.
- After you add more admins, the admin policy is re-signed. Refresh both `data/` files without touching the realm or the container with `EXPORT_ONLY=1 bash init/tcinit.sh` (`npm run init` would try to start a new container).

### Start over

Run this from `template-ts-app`, then `npm run init` again:

```bash
sudo docker rm -f mytidecloak
sudo rm -f keycloakdb.mv.db keycloakdb.trace.db
rm -rf db data/tidecloak.json data/admin-policy.b64
```

## The Default Contract

The included contract (`lib/forsetiContract.ts`) supports:

- **Role-based encryption** - restrict who can encrypt via `EncryptionRealmRole` parameter
- **Role-based decryption** - restrict who can decrypt via `DecryptionRealmRole` parameter
- **Tag-based time locks** - reads `DecryptTimeLock:{epoch}` tags from the encrypted data to block decryption before a specific time

The contract is editable in the app's sidebar. Any change updates the contract ID (SHA-512 hash) in real time, so you can experiment with custom logic.

## Configuration

Defaults live in `init/.env.example`. A variable already set in your shell wins over the file.

| Variable | Default | Description |
|---|---|---|
| `TIDECLOAK_LOCAL_URL` | `http://localhost:8080` | TideCloak server URL. `npm run init` always uses 8080; set this when calling `tcinit.sh` directly |
| `CLIENT_NAME` | `myclient` | OIDC client name |
| `CLIENT_APP_URL` | `http://localhost:3000` | App URL (for CORS/redirects) |
| `NEW_REALM_NAME` | `forseti-test` | TideCloak realm name |
| `KC_USER` | `admin` | TideCloak admin username |
| `KC_PASSWORD` | `password` | TideCloak admin password |
| `SUBSCRIPTION_EMAIL` | none | License email; set it to skip the prompt |
| `ALLOW_EXISTING_REALM` | unset | Set to `1` to run against a realm that already exists |
| `EXPORT_ONLY` | unset | Set to `1` to only refresh the two `data/` files |

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
    .env.example     Default settings
  lib/
    forsetiContract.ts   Default Forseti C# contract
    adminPolicy.ts       Reads the admin policy snapshot
    database/            SQLite policy storage
  data/              Generated adapter config and admin policy snapshot
  db/                SQLite database, created on first run
```
