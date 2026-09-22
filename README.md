# Forseti Crypto Quickstart

A small Next.js app that shows policy-governed encryption with TideCloak. You write a Forseti policy, approve it in the Tide enclave, commit it to the Tide network, then encrypt and decrypt data that the policy controls.

A run looks like this: log in, create a policy, review and approve it in the enclave popup, commit it, encrypt some text, decrypt it again.

## Prerequisites

- Docker (the init script runs `sudo docker`)
- Node.js 20.9 or newer (`.nvmrc` says 22)
- `bash`, `curl`, `jq`, `base64`
- A Chromium-based browser or Firefox

## Quick start

1. Clone the repo and go to the app folder.

   ```bash
   git clone https://github.com/tide-foundation/forseti-crypto-quickstart.git
   cd forseti-crypto-quickstart/template-ts-app
   ```

2. Initialise TideCloak. This asks for a licence email and terms acceptance, starts a `mytidecloak` container on port 8080, provisions the `forseti-test` realm, then prints an enrolment link and waits.

   ```bash
   npm run init
   ```

3. Open the enrolment link in your browser, create or sign in to a Tide account, and wait for the script to print "All done".

4. Install and start the app.

   ```bash
   npm install && npm run dev
   ```

5. Open http://localhost:3000 and log in with the account you just enrolled. Then Create a policy, Review it (approve in the popup), Commit it, Encrypt some text, and Decrypt it.

## What init produces

- `data/tidecloak.json`: the adapter config the app uses to talk to TideCloak.
- `data/admin-policy.b64`: the realm's signed admin policy. The app attaches it to every new Forseti policy so the network will accept it.

## Things you will hit

- On the first Create, Chrome 142 and later asks whether the enclave may reach your local network. Accept it. If Create then times out with `TIDE-TIDEJS-NET-TIMEOUT`, click Create again.
- The sign-in inside the enrolment link times out after about five minutes. If that happens, open the same link again and sign in again.
- Port 8080 already in use: `npm run init` pins the container to 8080. Start the container yourself on another port with `KC_HOSTNAME` set to match, then run `TIDECLOAK_LOCAL_URL=http://localhost:<port> bash init/tcinit.sh`.
- Running init again while the `forseti-test` realm exists is refused. Use the reset block below.
- After you add more admins, the admin policy is re-signed. Refresh the snapshot with `EXPORT_ONLY=1 bash init/tcinit.sh`.

## Start over

Run this from `template-ts-app`, then `npm run init` again:

```bash
sudo docker rm -f mytidecloak
sudo rm -f keycloakdb.mv.db keycloakdb.trace.db
rm -rf db data/tidecloak.json data/admin-policy.b64
```

## Configuration

Defaults live in `init/.env.example`. Set any of these in your shell before `npm run init` to override them.

| Variable | Default | What it does |
|---|---|---|
| `TIDECLOAK_LOCAL_URL` | `http://localhost:8080` | TideCloak URL (ignored by `npm run init`, which uses 8080; set it when calling `tcinit.sh` directly) |
| `NEW_REALM_NAME` | `forseti-test` | Realm to create |
| `CLIENT_NAME` | `myclient` | OIDC client to create |
| `CLIENT_APP_URL` | `http://localhost:3000` | This app's origin, used for redirect URIs and the enclave |
| `KC_USER` / `KC_PASSWORD` | `admin` / `password` | TideCloak bootstrap admin |
| `SUBSCRIPTION_EMAIL` | none | Licence email; set it to skip the prompt |
| `ALLOW_EXISTING_REALM` | unset | Set to `1` to run against a realm that already exists |
| `EXPORT_ONLY` | unset | Set to `1` to only refresh the two `data/` files |

## Project structure

```
template-ts-app/
  init/    start.sh (container), tcinit.sh (realm), realm.json, .env.example
  app/     Next.js routes: login, home (policy, encrypt, decrypt), API
  lib/     Forseti contract, TideCloak helpers, SQLite policy store
  data/    Generated adapter config and admin policy snapshot
  db/      SQLite database, created on first run
```
