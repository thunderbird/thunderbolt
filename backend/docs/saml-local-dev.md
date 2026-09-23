# SAML Authentication

Local setup for SAML 2.0, the auth mode for enterprise self-hosted deployments where users sign in through their organization's IdP (Keycloak, Okta, Entra ID). For OIDC, see [oidc-local-dev.md](./oidc-local-dev.md).

## How it works

`AUTH_MODE=saml` removes the login page. Unauthenticated users are redirected through a chain:

1. App detects no session, redirects to the backend's SSO sign-in endpoint
2. Backend generates a SAML AuthnRequest, redirects to the IdP's SSO URL
3. User authenticates with the IdP
4. IdP POSTs a signed assertion to the backend's ACS endpoint
5. Backend validates it, creates/updates user + session
6. Backend redirects to the frontend, authenticated

Any SAML 2.0-compliant provider works. Built on `@better-auth/sso` with `samlify`.

## Quick start (Keycloak example)

### 1. Start Keycloak with the pre-configured realm

`docs/mozilla-realm.json` holds a realm with OIDC and SAML clients plus test users. Mount it on startup:

```sh
cd backend  # the volume mount path resolves relative to backend/
docker run -d \
  --name keycloak \
  -p 8180:8080 \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
  -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
  -v $(pwd)/docs/mozilla-realm.json:/opt/keycloak/data/import/mozilla-realm.json \
  quay.io/keycloak/keycloak:latest \
  start-dev --import-realm
```

Realm `mozilla`, OIDC client `thunderbolt-app`, SAML client `thunderbolt-saml-sp`, users `mitchell@mozilla.org` and `laura@mozilla.org` (both `password`). Admin panel: http://localhost:8180 (`admin` / `admin`).

### 2. Extract the IdP signing certificate

Assertions are validated against it. Pull it from Keycloak's SAML descriptor:

```sh
# Option A: with xmllint (if installed)
curl -s http://localhost:8180/realms/mozilla/protocol/saml/descriptor \
  | xmllint --xpath '//ds:X509Certificate/text()' \
    --namespace ds=http://www.w3.org/2000/09/xmldsig# -

# Option B: with grep (works everywhere)
curl -s http://localhost:8180/realms/mozilla/protocol/saml/descriptor \
  | sed -n 's/.*<ds:X509Certificate>\(.*\)<\/ds:X509Certificate>.*/\1/p' | head -1

# Option C: Keycloak admin UI -> Realm Settings -> Keys -> RSA certificate -> copy
```

Copy the raw base64 value, no BEGIN/END markers.

### 3. Set environment variables

**Backend** (`backend/.env`):

```sh
AUTH_MODE=saml
WAITLIST_ENABLED=false
SAML_ENTRY_POINT=http://localhost:8180/realms/mozilla/protocol/saml
SAML_ENTITY_ID=thunderbolt-saml-sp
SAML_IDP_ISSUER=http://localhost:8180/realms/mozilla
SAML_CERT=<paste-certificate-from-step-2>
# Include the IdP origin in trusted origins
TRUSTED_ORIGINS=http://localhost:1420,http://localhost:8180
```

**Frontend** (`.env.local` in project root):

```sh
VITE_AUTH_MODE=sso
# VITE_BYPASS_WAITLIST must NOT be set (or set to false): it skips the auth gate entirely
```

### 4. Start backend and frontend

```sh
cd backend && bun dev  # terminal 1
bun dev                # terminal 2
```

Open http://localhost:1420, land on Keycloak's `mozilla` realm login, sign in as `mitchell@mozilla.org` / `password`.

## SP metadata

The backend serves SP metadata that enterprise admins point their IdP at:

```
http://localhost:8000/v1/api/auth/sso/saml2/sp/metadata?providerId=sso
```

## Using a different SAML provider

Provider-agnostic. Set all four vars; `backend/src/auth/auth.ts` throws at startup if any is missing.

```sh
SAML_ENTRY_POINT=https://your-idp.example.com/sso/saml
SAML_ENTITY_ID=thunderbolt-saml-sp
SAML_IDP_ISSUER=https://your-idp.example.com
SAML_CERT=<idp-signing-certificate-base64>
```

| Var               | Meaning                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SAML_ENTITY_ID`  | The _Service Provider's_ entity ID, as published in the SP metadata above. Must match the client/application ID registered in the IdP. |
| `SAML_IDP_ISSUER` | The IdP's own entity ID. Assertions are validated against it.                                                                          |

Register the ACS URL with the provider:

```
https://<your-backend>/v1/api/auth/sso/saml2/sp/acs/sso
```

## Troubleshooting

| Symptom                                | Cause                                       | Fix                                                                                           |
| -------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| App loads normally, no redirect to IdP | `VITE_BYPASS_WAITLIST` is set to `true`     | Remove it or set to `false`, restart frontend                                                 |
| App loads normally, no redirect to IdP | Stale auth session from a previous login    | Clear site data (DevTools → Application → Storage → Clear site data)                          |
| `discovery_untrusted_origin` error     | IdP origin not in `TRUSTED_ORIGINS`         | Add `http://localhost:8180` to `TRUSTED_ORIGINS` in `backend/.env`                            |
| Keycloak not reachable                 | Container not running                       | Run `docker ps \| grep keycloak` and start it if needed                                       |
| SAML ACS returns error                 | Wrong ACS URL in Keycloak SAML client       | Ensure `saml_assertion_consumer_url_post` matches `/v1/api/auth/sso/saml2/sp/acs/sso`         |
| Invalid certificate error              | Certificate has PEM headers or wrong format | Use the raw base64 string without `-----BEGIN CERTIFICATE-----` / `-----END CERTIFICATE-----` |

## SAML logout

Providers keep their own session, so signing out of Thunderbolt alone re-authenticates the user silently on the next visit. Expected SSO behavior.

## Files

| File                                        | Purpose                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------- |
| `backend/src/auth/auth.ts`                  | Conditionally adds `@better-auth/sso` plugin when `AUTH_MODE=saml`                 |
| `backend/src/config/settings.ts`            | `authMode`, `samlEntryPoint`, `samlEntityId`, `samlIdpIssuer`, `samlCert` env vars |
| `backend/src/auth/saml-integration.test.ts` | SAML integration tests                                                             |
| `backend/docs/mozilla-realm.json`           | Pre-configured Keycloak realm with SAML client                                     |
| `src/lib/auth-mode.ts`                      | `isSsoMode()` reads `VITE_AUTH_MODE`                                               |
| `src/app.tsx`                               | `SsoRedirect` component, conditional routing for SSO vs consumer mode              |
| `src/contexts/auth-context.tsx`             | `credentials: 'include'` in SSO mode for cookie-based session bootstrap            |
