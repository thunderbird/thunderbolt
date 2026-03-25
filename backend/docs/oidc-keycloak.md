# OIDC Authentication with Keycloak

This guide covers running and testing the OIDC authentication flow locally using Keycloak as the identity provider. This is the auth mode used for enterprise self-hosted deployments where all users sign in through their organization's identity provider.

## How it works

In OIDC mode (`AUTH_MODE=oidc`), the app has no login page. Unauthenticated users are immediately redirected through a chain:

1. App detects no session, redirects to backend's OIDC sign-in endpoint
2. Backend redirects to Keycloak's authorization endpoint
3. User authenticates in Keycloak (corporate SSO)
4. Keycloak redirects back to backend with an auth code
5. Backend exchanges code for tokens, creates/updates user + session
6. Backend redirects to frontend — user is authenticated

## Quick start

### 1. Start Keycloak with pre-configured realm

The `docs/amazon-realm.json` file contains a ready-to-go realm with a client and test users. Mount it on startup so there's zero manual setup:

```sh
docker run -d \
  --name keycloak \
  -p 8180:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -v $(pwd)/docs/amazon-realm.json:/opt/keycloak/data/import/amazon-realm.json \
  quay.io/keycloak/keycloak:latest \
  start-dev --import-realm
```

This creates:
- **Realm**: `amazon`
- **Client**: `thunderbolt-app` (secret: `thunderbolt-dev-secret`)
- **Users**: `jeff@amazon.com` / `password`, `andy@amazon.com` / `password`

Keycloak admin panel is at http://localhost:8180 (login: `admin` / `admin`).

### 2. Set environment variables

**Backend** (`backend/.env`):

```sh
AUTH_MODE=oidc
WAITLIST_ENABLED=false
KEYCLOAK_CLIENT_ID=thunderbolt-app
KEYCLOAK_CLIENT_SECRET=thunderbolt-dev-secret
KEYCLOAK_ISSUER=http://localhost:8180/realms/amazon
```

**Frontend** (`.env.local` in project root, or whatever your local `.env` file is called):

```sh
VITE_AUTH_MODE=oidc
```

### 3. Start backend and frontend

```sh
# Terminal 1 — backend
cd backend && bun dev

# Terminal 2 — frontend
bun dev
```

Open http://localhost:1420 — you should be redirected to Keycloak's login page for the "amazon" realm. Sign in as `jeff@amazon.com` / `password`.

## Pre-configured realm

The realm import file at `docs/amazon-realm.json` defines everything Keycloak needs. To modify it:

- **Add users**: Add entries to the `users` array with `username`, `email`, `credentials`
- **Change client secret**: Update `clients[0].secret` and your `KEYCLOAK_CLIENT_SECRET` env var
- **Change redirect URIs**: Update `clients[0].redirectUris` (must match your backend's callback URL)

After modifying the JSON, remove the old container and re-run the docker command:

```sh
docker rm -f keycloak
# Then run the docker command from step 1 again
```

## OIDC logout

Keycloak maintains its own session. Logging out of Thunderbolt alone won't clear the Keycloak session — the user will be silently re-authenticated on the next visit. To fully log out (clear both sessions), the user would need to be redirected to Keycloak's logout endpoint:

```
http://localhost:8180/realms/amazon/protocol/openid-connect/logout
```

This is expected SSO behavior. In enterprise deployments, users typically stay signed in via their corporate identity provider.

## Deploying to staging (Render)

For staging on Render, you can't use a local Keycloak. Options:

- Use your company's existing Keycloak sandbox (ask for a realm, client, and test users)
- Deploy Keycloak as a Render Docker service using the same image and realm import

What you'll need from whoever manages the Keycloak instance:

| Value | Maps to env var | Example |
|-------|----------------|---------|
| Issuer URL (realm URL) | `KEYCLOAK_ISSUER` | `https://keycloak.company.com/realms/thunderbolt` |
| Client ID | `KEYCLOAK_CLIENT_ID` | `thunderbolt-app` |
| Client secret | `KEYCLOAK_CLIENT_SECRET` | (from Keycloak credentials tab) |

You'll need to give them your **callback URL** to add as a valid redirect URI:

```
https://<your-backend>.onrender.com/v1/api/auth/oauth2/callback/keycloak
```

## Files overview

| File | Purpose |
|------|---------|
| `backend/src/auth/auth.ts` | Conditionally adds `genericOAuth` + `keycloak` plugin when `AUTH_MODE=oidc` |
| `backend/src/config/settings.ts` | `authMode`, `keycloakClientId`, `keycloakClientSecret`, `keycloakIssuer` env vars |
| `backend/docs/amazon-realm.json` | Pre-configured Keycloak realm for local development |
| `src/lib/auth-mode.ts` | `isOidcMode()` — reads `VITE_AUTH_MODE` |
| `src/app.tsx` | `OidcRedirect` component, conditional routing for OIDC vs consumer mode |
| `src/contexts/auth-context.tsx` | `credentials: 'include'` in OIDC mode for cookie-based session bootstrap |
