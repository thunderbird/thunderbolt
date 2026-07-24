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

Response contains plaintext `key` once. Store that value as `THUNDERBOLT_TOKEN`. New keys expire after `API_KEY_DEFAULT_EXPIRES_IN` seconds; default is `7776000` seconds (90 days). Creation may include `expiresIn` in seconds to request another plugin-supported lifetime (currently 1–365 days). Listing never returns plaintext key.

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

Deletion revokes key immediately. If PAT may be compromised, revoke it, replace stored `THUNDERBOLT_TOKEN`, and issue a new key. CLI reads PAT from `THUNDERBOLT_TOKEN` and sends it as `x-api-key`; API-key sessions and disabled per-key rate limiting are deliberate for headless automation. Account/IP-level limits still apply.
