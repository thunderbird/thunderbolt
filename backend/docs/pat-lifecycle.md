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

The CLI treats a PAT as environment-managed, headless authentication. Managed
inference through a PAT is direct-only, and a PAT does not register a CLI device.

## Confidential models and PATs

By default a PAT is refused on the confidential routes (`/v1/tinfoil/*` and the
usage-receipt endpoint) with `403 WEB_LOGIN_REQUIRED`, and the CLI does not replay
that failure through another provider. Set `CONFIDENTIAL_API_KEYS_ENABLED=true` to
allow it.

The gate is an authorization choice, not a cryptographic one. Confidentiality comes
from the caller: the Tinfoil SDK attests the enclave and HPKE-seals the body, and the
proxy forwards ciphertext it cannot read. The `userCacheSecret` that partitions the
enclave's prompt cache is generated client-side — `randomBytes(32)` in the CLI,
`crypto.getRandomValues` in the browser — and never reaches the backend, so any
PAT-authenticated caller can supply its own. What a PAT lacks is the device binding a
web session carries, and it lives longer; since confidential inference is metered
against the account, enabling the flag means accepting spend on that tier from a
long-lived headless credential.

The CLI itself still requires `thunderbolt login` for confidential models regardless
of this flag: `resolveAccountCredential` returns no cache secret on the PAT path, so
`createTinfoilBinding` has nothing to namespace with. The flag exists for service
callers that manage their own cache secret, such as a backend using `tinfoil-python`
with `base_url` pointed at `/v1/tinfoil`.

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

Deletion revokes key immediately. If PAT may be compromised, revoke it, replace
stored `THUNDERBOLT_TOKEN`, and issue a new key. `thunderbolt logout` only revokes
the stored web session and its bound CLI device; it cannot remove a token from
the process environment or revoke that PAT remotely.

The CLI reads PAT from `THUNDERBOLT_TOKEN` and sends it as `x-api-key`; API-key
sessions and disabled per-key rate limiting are deliberate for headless
automation. Account/IP-level limits still apply.
