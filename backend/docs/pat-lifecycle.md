# Personal access token lifecycle

Better Auth serves API-key endpoints under `/v1/api/auth`. Set backend origin and an authenticated session token before managing personal access tokens (PATs):

```bash
export THUNDERBOLT_API="http://localhost:8000"
export SESSION_TOKEN="<interactive-session-token>"
```

## Create

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$THUNDERBOLT_API/v1/api/auth/api-key/create" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"ci"}'
```

Response contains the plaintext `key` once. Store that value as `THUNDERBOLT_TOKEN`. New keys expire after `API_KEY_DEFAULT_EXPIRES_IN` seconds; the default is `7776000` seconds (90 days). The create request may include `expiresIn` (seconds) to request a different lifetime supported by the plugin (currently 1–365 days). Listing never returns the plaintext key.

## List

```bash
curl --fail-with-body --silent --show-error \
  "$THUNDERBOLT_API/v1/api/auth/api-key/list" \
  -H "Authorization: Bearer $SESSION_TOKEN"
```

## Revoke

Use key `id` from create or list response:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$THUNDERBOLT_API/v1/api/auth/api-key/delete" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"keyId":"<key-id>"}'
```

Deletion revokes the key immediately. If a PAT may be compromised, revoke it, replace the stored `THUNDERBOLT_TOKEN`, and issue a new key. The CLI reads the PAT from `THUNDERBOLT_TOKEN` and sends it as `x-api-key`; API-key sessions carry a generous per-key rate limit (300 requests/minute) sized for headless automation. Account/IP-level limits still apply.
