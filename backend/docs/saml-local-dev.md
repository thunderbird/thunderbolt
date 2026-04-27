# SAML Authentication

This guide covers running and testing the SAML 2.0 authentication flow locally. This is an auth mode for enterprise self-hosted deployments where users sign in through their organization's SAML identity provider (Keycloak, Okta, Microsoft Entra ID, etc.).

For OIDC authentication, see [oidc-local-dev.md](./oidc-local-dev.md).

## How it works

In SAML mode (`AUTH_MODE=saml`), the app has no login page. Unauthenticated users are immediately redirected through a chain:

1. App detects no session, redirects to backend's SSO sign-in endpoint
2. Backend generates a SAML AuthnRequest and redirects to the IdP's SSO URL
3. User authenticates with their identity provider (corporate SSO)
4. IdP POSTs a signed SAML assertion back to the backend's ACS endpoint
5. Backend validates the assertion, creates/updates user + session
6. Backend redirects to frontend — user is authenticated

Any SAML 2.0-compliant provider works. The implementation uses the `@better-auth/sso` plugin with the `samlify` library.

## Quick start (Keycloak example)

### 1. Start Keycloak with pre-configured realm

The `docs/mozilla-realm.json` file contains a ready-to-go realm with both OIDC and SAML clients plus test users. Mount it on startup so there's zero manual setup:

```sh
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
- **OIDC client**: `thunderbolt-app` (for OIDC mode)
- **SAML client**: `thunderbolt-saml-sp` (for SAML mode)
- **Users**: `mitchell@mozilla.org` / `password`, `laura@mozilla.org` / `password`

Keycloak admin panel is at http://localhost:8180 (login: `admin` / `admin`).

### 2. Extract the IdP signing certificate

The SAML flow requires the IdP's signing certificate to validate assertions. Extract it from Keycloak's SAML descriptor:

```sh
# Option A: with xmllint (if installed)
curl -s http://localhost:8180/realms/mozilla/protocol/saml/descriptor \
  | xmllint --xpath '//ds:X509Certificate/text()' \
    --namespace ds=http://www.w3.org/2000/09/xmldsig# -

# Option B: with grep (works everywhere)
curl -s http://localhost:8180/realms/mozilla/protocol/saml/descriptor \
  | grep -oP '(?<=<ds:X509Certificate>).*(?=</ds:X509Certificate>)' | head -1

# Option C: Keycloak admin UI -> Realm Settings -> Keys -> RSA certificate -> copy
```

Copy the certificate value (base64 string, no BEGIN/END markers).

### 3. Set environment variables

**Backend** (`backend/.env`):

```sh
AUTH_MODE=saml
WAITLIST_ENABLED=false
SAML_ENTRY_POINT=http://localhost:8180/realms/mozilla/protocol/saml
SAML_ISSUER=http://localhost:8180/realms/mozilla
SAML_CERT=<paste-certificate-from-step-2>
```

**Frontend** (`.env.local` in project root):

```sh
VITE_AUTH_MODE=saml
```

### 4. Start backend and frontend

```sh
# Terminal 1 — backend
cd backend && bun dev

# Terminal 2 — frontend
bun dev
```

Open http://localhost:1420 — you should be redirected to Keycloak's login page for the "mozilla" realm. Sign in as `mitchell@mozilla.org` / `password`.

## SP Metadata

The backend exposes Service Provider metadata at:

```
http://localhost:8000/v1/api/auth/sso/saml2/sp/metadata?providerId=saml
```

Enterprise admins can use this to configure their IdP.

## Using a different SAML provider

The implementation is provider-agnostic. To use Okta, Entra ID, or any other SAML 2.0 provider, set the three env vars:

```sh
SAML_ENTRY_POINT=https://your-idp.example.com/sso/saml
SAML_ISSUER=https://your-idp.example.com
SAML_CERT=<idp-signing-certificate-base64>
```

You'll need to register the ACS URL with the provider:

```
https://<your-backend>/v1/api/auth/sso/saml2/sp/acs/saml
```

## SAML logout

Most SAML providers maintain their own session. Logging out of Thunderbolt alone won't clear the provider session — the user will be silently re-authenticated on the next visit. This is expected SSO behavior.

## Files overview

| File | Purpose |
|------|---------|
| `backend/src/auth/auth.ts` | Conditionally adds `@better-auth/sso` plugin when `AUTH_MODE=saml` |
| `backend/src/config/settings.ts` | `authMode`, `samlEntryPoint`, `samlIssuer`, `samlCert` env vars |
| `backend/src/auth/saml-integration.test.ts` | SAML integration tests |
| `backend/docs/mozilla-realm.json` | Pre-configured Keycloak realm with SAML client |
| `src/lib/auth-mode.ts` | `isSamlMode()`, `isSsoMode()` — reads `VITE_AUTH_MODE` |
| `src/app.tsx` | `SsoRedirect` component, conditional routing for SSO vs consumer mode |
| `src/contexts/auth-context.tsx` | `credentials: 'include'` in SSO mode for cookie-based session bootstrap |
