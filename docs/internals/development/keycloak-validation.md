# Keycloak Validation Stack

A local stack that runs SSO and SCIM provisioning end to end against real identity providers: one Keycloak with several realms, each a separate SSO connection with its own SCIM connection, all provisioning into one org through the real outbound SCIM extension. It backs the claims in [Provisioning](../../self-hosting/provisioning.md) and in [Identity and Access](../architecture/identity-and-access.md). Run it locally as below; [`nightly-keycloak.yml`](../../../.github/workflows/nightly-keycloak.yml) runs the same steps every night, and on pull requests that change `e2e/keycloak/`, without gating anything.

The CI-side counterparts run in `bun run test:backend` with a fake IdP: [`multi-connection.test.ts`](../../../backend/src/identity/multi-connection.test.ts) (isolation between connections, also on Postgres), [`upgrade.test.ts`](../../../backend/src/identity/upgrade.test.ts) (an existing deployment upgrading with no config change) and [`outage.test.ts`](../../../backend/src/identity/outage.test.ts) (no IdP call on the request path).

## What is in it

Everything is in [`e2e/keycloak/`](../../../e2e/keycloak):

| File                           | What                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`           | Postgres (5435, a `thunderbolt` and a `keycloak` database), Keycloak (8280) and `scim-loopback`                                                          |
| `keycloak.Dockerfile`          | Builds the extension from the commit in `extension.lock`, checks the fetched commit's hash, and adds it to Keycloak                                      |
| `extension.lock`               | The extension's repository, branch and commit, and every image the stack uses by digest. Bump only to a reviewed commit, then rerun everything       |
| `realms/*.json`                | The realms Keycloak imports at startup (below)                                                                                                           |
| `backend.env`                  | The backend's settings, for a backend on the host from your working tree                                                                                 |
| `setup.ts`                     | Connects each realm as an admin would. Writes `.state.json` (gitignored) with the ids and tokens the suites need                                         |
| `*.test.ts`                    | The suites (below)                                                                                                                                       |

| Realm     | Protocol | Domain                         | Match claim  | Notes                                                                 |
| --------- | -------- | ------------------------------ | ------------ | --------------------------------------------------------------------- |
| `acme`    | OIDC     | `acme.test`, verified, claimed | `sub`        | Group `acme-admins` is mapped to the admin role by its SCIM group id  |
| `globex`  | OIDC     | `globex.test`, verified, claimed | `sub`      | The extension names SCIM users by email                               |
| `initech` | SAML     | `initech.test`, verified, unclaimed | `kcUserId` | An attribute carrying the Keycloak user id                            |
| `legacy`  | OIDC     | —                              | `sub`        | The backend's `OIDC_*` provider: the env connection `sso`, without SCIM |

`alice` exists in `acme` and `globex`, and `pat@contractor.test` in `acme` and `initech`, so the realms collide on purpose. Every seeded user's password is `password`.

**Why `scim-loopback`.** The extension refuses plain HTTP except to a loopback address. `scim-loopback` shares Keycloak's network namespace and forwards its `127.0.0.1:18000` to the backend on the host, so every SCIM target points at `http://127.0.0.1:18000/v1/api/auth/scim/v2`. It forwards over IPv4, and `backend.env` binds the backend to `127.0.0.1` (`HOST`), because Docker Desktop's `host.docker.internal` reaches the host's IPv4 loopback and the backend otherwise listens on `localhost`, which can be IPv6 only. On Linux CI the backend binds `0.0.0.0` instead (`HOST=0.0.0.0` overrides `backend.env`), because there `host-gateway` is the Docker bridge's gateway, not the host's loopback.

**Why `NODE_ENV=test`.** It makes the backend accept the fixed sign-in code `12345678`, which is how `setup.ts` signs in the bootstrap admin `admin@thunderbolt.test`. It belongs to `backend.env` only: `deploy/docker/backend-image.test.ts` and the Helm tests fail if a packaged Compose file or the chart sets it.

**Domain verification without DNS.** `.test` domains can't hold a TXT record, so `setup.ts` verifies them with [`backend/scripts/verify-org-domain-dev.ts`](../../../backend/scripts/verify-org-domain-dev.ts), which runs the real `verifyOrgDomain` with a resolver answering the domain's own token. The script refuses to run unless `NODE_ENV` is `development` or `test` and the database is local. It is not part of the app: the backend image copies only `backend/src`, and `deploy/docker/backend-image.test.ts` fails if the image ever copies `backend/scripts` or if anything in `backend/src` imports from it.

## Run it

```sh
# 1. The stack. The first build compiles the extension (a few minutes, needs network).
docker compose -f e2e/keycloak/docker-compose.yml --env-file e2e/keycloak/extension.lock up -d --build

# 2. The backend, from your working tree, in its own terminal.
cd backend && bun --env-file=../e2e/keycloak/backend.env src/index.ts

# 3. Connect the realms. Safe to run again.
bun e2e/keycloak/setup.ts

# 4. The suites.
bun run test:keycloak
```

Tear it down with `docker compose -f e2e/keycloak/docker-compose.yml --env-file e2e/keycloak/extension.lock down -v`, and delete `e2e/keycloak/.state.json` with it. The Keycloak admin console is at <http://localhost:8280> (`admin` / `admin`).

## The suites

| Suite                   | Covers                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `realm-matrix.test.ts`  | Per realm: SSO sign-in through the real login form, an unprovisioned subject refused, login discovery, create, profile/username/email changes, disable and re-enable, SSO-only, `DELETE` in both deprovision modes, reprovisioning with the same and a new Keycloak id, groups, and group-to-role mapping |
| `isolation.test.ts`     | The shared `alice` stays two people, the shared address waits for review and then links without merging, one realm's token can't reach another's users, and events name their own connection          |
| `outage.test.ts`        | Thunderbolt unreachable (stops `scim-loopback`): the extension logs pending work and catches up. Keycloak down: sessions and discovery keep working, a new SSO sign-in fails, the break-glass admin gets in |
| `load.test.ts`          | A Keycloak full sync of `KEYCLOAK_LOAD_USERS` imported users, timed. Run with `bun run test:keycloak:load` against a backend started with `RATE_LIMIT_ENABLED=true`, so the SCIM budget applies      |

The extension delivers after Keycloak's own transaction commits, so every assertion polls until Thunderbolt shows the change. After an approved link review, the isolation suite resets the extension's `create_outcome_unknown` row, as an operator must (see [Provisioning](../../self-hosting/provisioning.md#collisions-and-the-review-queue)). Runs leave their users behind with unique names; tear the stack down for a clean slate. Run `load.test.ts` last: the users it leaves in `globex` make every later full sync of that realm slow enough to time out the scenario suites.

`bun run test:scim-load` is the in-process counterpart of `load.test.ts`: 5,000 Entra-shaped users from four app instances on `TEST_POSTGRES_URL`, then the same sync again. Set `SCIM_LOAD_BUDGET=1` to apply the SCIM budget.

## What it can't cover

- Keycloak user ids are unique across realms, so one `externalId` from two Keycloak realms can't happen here. `multi-connection.test.ts` covers it.
- Entra and Okta, and the Microsoft SCIM Validator, need real tenants.
