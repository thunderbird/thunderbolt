# OIDC Authentication

OIDC (`AUTH_MODE=oidc`) is the auth mode for enterprise self-hosted deployments: every user signs in through their organization's identity provider (Keycloak, Okta, Auth0, Microsoft Entra ID).

## How it works

There is no login page. Unauthenticated users are redirected through a chain:

1. App sees no session, redirects to the backend's OIDC sign-in endpoint
2. Backend redirects to the provider's authorization endpoint
3. User authenticates with the corporate IdP
4. Provider redirects back with an auth code
5. Backend exchanges the code for tokens, creates or updates user + session
6. Backend redirects to the frontend, authenticated

## Quick start (Keycloak example)

### 1. Start Keycloak with the pre-configured realm

`docs/mozilla-realm.json` is a ready-made realm (client + test users). Mount it:

```sh
cd backend  # run from backend/ so the volume mount path resolves correctly
docker run -d \
  --name keycloak \
  -p 8180:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -v $(pwd)/docs/mozilla-realm.json:/opt/keycloak/data/import/mozilla-realm.json \
  quay.io/keycloak/keycloak:latest \
  start-dev --import-realm
```

This creates:

- **Realm**: `mozilla`
- **Client**: `thunderbolt-app` (secret: `thunderbolt-dev-secret`)
- **Users**: `mitchell@mozilla.org` / `password`, `laura@mozilla.org` / `password`
- **Admin panel**: http://localhost:8180 (`admin` / `admin`)

### 2. Set environment variables

**Backend** (`backend/.env`):

```sh
AUTH_MODE=oidc
OIDC_CLIENT_ID=thunderbolt-app
OIDC_CLIENT_SECRET=thunderbolt-dev-secret
OIDC_ISSUER=http://localhost:8180/realms/mozilla
# The SSO plugin validates discovery URLs against trusted origins, so include the IdP origin
TRUSTED_ORIGINS=http://localhost:1420,http://localhost:8180
```

No waitlist variable belongs here. Both waitlist checks in `backend/src/auth/auth.ts` are on the email-OTP path (the `before` hook returns early for anything but `otpSignInPath`; the other is in the `sendVerificationOTP` callback), so SSO never reaches them. `WAITLIST_ENABLED` is inert even in consumer mode: `settings.waitlistEnabled` (`backend/src/config/settings.ts`) is read by nothing outside tests, so the gate always runs and `WAITLIST_AUTO_APPROVE_DOMAINS` is the only lever.

**Frontend** (`.env.local` in the project root):

```sh
VITE_AUTH_MODE=sso
# VITE_BYPASS_WAITLIST must NOT be set (or set to false); it skips the auth gate entirely
```

### 3. Start backend and frontend

```sh
# Terminal 1: backend
cd backend && bun dev

# Terminal 2: frontend
bun dev
```

Open http://localhost:1420. You should land on Keycloak's `mozilla` realm login; sign in as `mitchell@mozilla.org` / `password`.

## Pre-configured realm

To change `docs/mozilla-realm.json`:

- **Add users**: entries in the `users` array with `username`, `email`, `credentials`
- **Change client secret**: `clients[0].secret` plus your `OIDC_CLIENT_SECRET`
- **Change redirect URIs**: `clients[0].redirectUris` (must match the backend's callback URL)

Then recreate the container:

```sh
docker rm -f keycloak
# Then run the docker command from step 1 again
```

## Using a different OIDC provider

The implementation is provider-agnostic: set the three env vars for any OIDC provider that serves discovery at `{OIDC_ISSUER}/.well-known/openid-configuration`.

```sh
# Okta example
OIDC_CLIENT_ID=0oaXXXXXXXXXXXXXXX
OIDC_CLIENT_SECRET=your-client-secret
OIDC_ISSUER=https://your-org.okta.com

# Auth0 example
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_ISSUER=https://your-tenant.auth0.com

# Microsoft Entra ID example
OIDC_CLIENT_ID=your-app-registration-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_ISSUER=https://login.microsoftonline.com/your-tenant-id/v2.0
```

Callback URL to register:

```
https://<your-backend>/v1/api/auth/sso/callback/sso
```

## OIDC logout

Most providers keep their own session, so signing out of Thunderbolt does not clear it and the next visit silently re-authenticates. Expected SSO behavior.

## Deploying to staging (Render)

A local OIDC provider is not usable from Render. Use your company's IdP sandbox (ask for a client ID, secret, and test users), or deploy Keycloak as a Render Docker service with the same image and realm import.

What you need from the IdP owner:

| Value         | Maps to env var      | Example                                           |
| ------------- | -------------------- | ------------------------------------------------- |
| Issuer URL    | `OIDC_ISSUER`        | `https://keycloak.company.com/realms/thunderbolt` |
| Client ID     | `OIDC_CLIENT_ID`     | `thunderbolt-app`                                 |
| Client secret | `OIDC_CLIENT_SECRET` | (from the provider's credentials page)            |

Callback URL to register:

```
https://<your-backend>.onrender.com/v1/api/auth/sso/callback/sso
```

## Troubleshooting

| Symptom                                | Cause                                    | Fix                                                                         |
| -------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| App loads normally, no redirect to IdP | `VITE_BYPASS_WAITLIST` is set to `true`  | Remove it or set to `false`, restart frontend                               |
| App loads normally, no redirect to IdP | Stale auth session from a previous login | Clear site data (DevTools → Application → Storage → Clear site data)        |
| `discovery_untrusted_origin` error     | IdP origin not in `TRUSTED_ORIGINS`      | Add `http://localhost:8180` to `TRUSTED_ORIGINS` in `backend/.env`          |
| `discovery_unexpected_error` error     | Keycloak is not running or not reachable | Run `docker ps \| grep keycloak` and start it if needed                     |
| OIDC callback 404                      | Wrong redirect URI in Keycloak client    | Ensure `redirectUris` in realm JSON matches `/v1/api/auth/sso/callback/sso` |

## Testing

Backend tests need no Docker and no mock IdP: they stub `globalThis.fetch` so OIDC discovery, the only outbound call, returns a hand-written `.well-known/openid-configuration`. Covered: redirect URL, PKCE `code_challenge`, scopes, the three missing-config failures, and rejection of SSO sign-in under `AUTH_MODE=consumer`.

```sh
cd backend && bun test src/auth/oidc-integration.test.ts
```

Playwright runs a real provider: `e2e/global-setup.ts` starts `oauth2-mock-server` on `MOCK_OIDC_PORT` (default `9876`).

## Files overview

| File                                        | Purpose                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| `backend/src/auth/auth.ts`                  | Conditionally adds `@better-auth/sso` plugin when `AUTH_MODE=oidc` or `saml` |
| `backend/src/config/settings.ts`            | `authMode`, `oidcClientId`, `oidcClientSecret`, `oidcIssuer` env vars        |
| `backend/src/auth/oidc-integration.test.ts` | OIDC integration tests with a stubbed discovery endpoint                     |
| `backend/docs/mozilla-realm.json`           | Pre-configured Keycloak realm for local development (OIDC + SAML clients)    |
| `src/lib/auth-mode.ts`                      | `isSsoMode()`, reads `VITE_AUTH_MODE`                                        |
| `src/app.tsx`                               | `SsoRedirect` component, conditional routing for SSO vs consumer mode        |
| `src/contexts/auth-context.tsx`             | `credentials: 'include'` in SSO mode for cookie-based session bootstrap      |
