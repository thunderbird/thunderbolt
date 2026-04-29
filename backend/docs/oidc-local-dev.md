# OIDC Authentication

This guide covers running and testing the OIDC authentication flow locally. This is the auth mode used for enterprise self-hosted deployments where all users sign in through their organization's identity provider (Keycloak, Okta, Auth0, Microsoft Entra ID, etc.).

## How it works

In OIDC mode (`AUTH_MODE=oidc`), the app has no login page. Unauthenticated users are immediately redirected through a chain:

1. App detects no session, redirects to backend's OIDC sign-in endpoint
2. Backend redirects to the OIDC provider's authorization endpoint
3. User authenticates with their identity provider (corporate SSO)
4. Provider redirects back to backend with an auth code
5. Backend exchanges code for tokens, creates/updates user + session
6. Backend redirects to frontend — user is authenticated

Any OIDC-compliant provider works — the implementation uses standard OIDC discovery (`.well-known/openid-configuration`).

## Quick start (Keycloak example)

### 1. Start Keycloak with pre-configured realm

The `docs/mozilla-realm.json` file contains a ready-to-go realm with a client and test users. Mount it on startup so there's zero manual setup:

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

Keycloak admin panel is at http://localhost:8180 (login: `admin` / `admin`).

### 2. Set environment variables

**Backend** (`backend/.env`):

```sh
AUTH_MODE=oidc
WAITLIST_ENABLED=false
OIDC_CLIENT_ID=thunderbolt-app
OIDC_CLIENT_SECRET=thunderbolt-dev-secret
OIDC_ISSUER=http://localhost:8180/realms/mozilla
# The SSO plugin validates discovery URLs against trusted origins — include the IdP origin
TRUSTED_ORIGINS=http://localhost:1420,http://localhost:8180
```

**Frontend** (`.env.local` in project root, or whatever your local `.env` file is called):

```sh
VITE_AUTH_MODE=oidc
# Make sure VITE_BYPASS_WAITLIST is NOT set (or set to false) — it skips the auth gate entirely
```

### 3. Start backend and frontend

```sh
# Terminal 1 — backend
cd backend && bun dev

# Terminal 2 — frontend
bun dev
```

Open http://localhost:1420 — you should be redirected to Keycloak's login page for the "mozilla" realm. Sign in as `mitchell@mozilla.org` / `password`.

## Pre-configured realm

The realm import file at `docs/mozilla-realm.json` defines everything Keycloak needs. To modify it:

- **Add users**: Add entries to the `users` array with `username`, `email`, `credentials`
- **Change client secret**: Update `clients[0].secret` and your `OIDC_CLIENT_SECRET` env var
- **Change redirect URIs**: Update `clients[0].redirectUris` (must match your backend's callback URL)

After modifying the JSON, remove the old container and re-run the docker command:

```sh
docker rm -f keycloak
# Then run the docker command from step 1 again
```

## Using a different OIDC provider

The implementation is provider-agnostic. To use Okta, Auth0, Entra ID, or any other OIDC provider, just set the three env vars:

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

The only requirement is that the provider supports OIDC discovery at `{OIDC_ISSUER}/.well-known/openid-configuration`.

You'll need to register a callback URL with the provider:

```
https://<your-backend>/v1/api/auth/sso/callback/oidc
```

## OIDC logout

Most OIDC providers maintain their own session. Logging out of Thunderbolt alone won't clear the provider session — the user will be silently re-authenticated on the next visit. This is expected SSO behavior. In enterprise deployments, users typically stay signed in via their corporate identity provider.

## Deploying to staging (Render)

For staging on Render, you can't use a local OIDC provider. Options:

- Use your company's existing identity provider sandbox (ask for a client ID, secret, and test users)
- Deploy Keycloak as a Render Docker service using the same image and realm import

What you'll need from whoever manages the identity provider:

| Value | Maps to env var | Example |
|-------|----------------|---------|
| Issuer URL | `OIDC_ISSUER` | `https://keycloak.company.com/realms/thunderbolt` |
| Client ID | `OIDC_CLIENT_ID` | `thunderbolt-app` |
| Client secret | `OIDC_CLIENT_SECRET` | (from provider's credentials page) |

You'll need to give them your **callback URL** to register:

```
https://<your-backend>.onrender.com/v1/api/auth/sso/callback/oidc
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| App loads normally, no redirect to IdP | `VITE_BYPASS_WAITLIST` is set to `true` | Remove it or set to `false`, restart frontend |
| App loads normally, no redirect to IdP | Stale auth session from a previous login | Clear site data (DevTools → Application → Storage → Clear site data) |
| `discovery_untrusted_origin` error | IdP origin not in `TRUSTED_ORIGINS` | Add `http://localhost:8180` to `TRUSTED_ORIGINS` in `backend/.env` |
| `discovery_unexpected_error` error | Keycloak is not running or not reachable | Run `docker ps \| grep keycloak` and start it if needed |
| OIDC callback 404 | Wrong redirect URI in Keycloak client | Ensure `redirectUris` in realm JSON matches `/v1/api/auth/sso/callback/oidc` |

## Testing

Integration tests use `oauth2-mock-server` — a lightweight in-process OIDC server that needs no Docker:

```sh
cd backend && bun test src/auth/oidc-integration.test.ts
```

## Files overview

| File | Purpose |
|------|---------|
| `backend/src/auth/auth.ts` | Conditionally adds `@better-auth/sso` plugin when `AUTH_MODE=oidc` or `saml` |
| `backend/src/config/settings.ts` | `authMode`, `oidcClientId`, `oidcClientSecret`, `oidcIssuer` env vars |
| `backend/src/auth/oidc-integration.test.ts` | OIDC integration tests using mock OIDC server |
| `backend/docs/mozilla-realm.json` | Pre-configured Keycloak realm for local development (OIDC + SAML clients) |
| `src/lib/auth-mode.ts` | `isOidcMode()`, `isSamlMode()`, `isSsoMode()` — reads `VITE_AUTH_MODE` |
| `src/app.tsx` | `SsoRedirect` component, conditional routing for SSO vs consumer mode |
| `src/contexts/auth-context.tsx` | `credentials: 'include'` in SSO mode for cookie-based session bootstrap |
