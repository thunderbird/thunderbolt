# Personal access token lifecycle

Better Auth serves API-key endpoints under `/v1/api/auth`. Managing personal access tokens (PATs) needs a backend origin and an authenticated session token:

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

The response contains the plaintext `key` once; store it as `THUNDERBOLT_TOKEN`. Listing never returns it again.

| Property          | Value                                                             |
| ----------------- | ----------------------------------------------------------------- |
| Default lifetime  | `API_KEY_DEFAULT_EXPIRES_IN` seconds, default `7776000` (90 days) |
| Per-key override  | `expiresIn` (seconds) on create, 1–365 days                       |
| CLI transport     | read from `THUNDERBOLT_TOKEN`, sent as `x-api-key`                |
| Managed inference | direct-only                                                       |
| CLI device        | a PAT does not register one                                       |

## Confidential models and PATs

By default a PAT is refused on the confidential routes (`/v1/tinfoil/*`) with `403 WEB_LOGIN_REQUIRED`, and the CLI does not replay that failure through another provider. Set `CONFIDENTIAL_API_KEYS_ENABLED=true` to allow it.

The gate is an authorization choice, not a cryptographic one. Confidentiality comes from the caller: the Tinfoil SDK attests the enclave and HPKE-seals the body, and the proxy forwards ciphertext it cannot read. The `userCacheSecret` that partitions the enclave's prompt cache is generated client-side (`randomBytes(32)` in the CLI, `crypto.getRandomValues` in the browser) and never reaches the backend, so any PAT-authenticated caller can supply its own. What a PAT lacks is the device binding a web session carries, and it lives longer; confidential inference is metered against the account, so enabling the flag means accepting spend on that tier from a long-lived headless credential.

The CLI still requires `thunderbolt login` for confidential models regardless of the flag: `resolveAccountCredential` returns no cache secret on the PAT path, so `createTinfoilBinding` has nothing to namespace with. The flag is for service callers that manage their own cache secret, such as a backend using `tinfoil-python` with `base_url` pointed at `/v1/tinfoil`.

### Metering for a service caller

The backend meters these calls itself, so a service caller has nothing to submit. The proxy cannot read the ciphertext it forwards, so it asks the enclave for a usage report and writes the account's ledger row at the price loaded at admission. Closing the stream early does not lower the charge, because the backend reads the response to the end to get the report.

Send `X-Inference-Model` with the model you call. The backend prices the call as that model and has the enclave reject, with 400, a body that names another one. Without the header the call is priced as `glm-5-3`, so the body must name `glm-5-3`. An unrecognised value is rejected with 400 before anything reaches the enclave. Only `POST /v1/tinfoil/v1/chat/completions` is metered; other paths, such as audio, are forwarded without a charge. If the enclave's report never arrives, the call stays charged at its hold: the most it could cost, capped at what was left of the limit.

## List

```bash
curl --fail-with-body --silent --show-error \
  "$THUNDERBOLT_API/v1/api/auth/api-key/list" \
  -H "Authorization: Bearer $SESSION_TOKEN"
```

## Revoke

Use the key `id` from the create or list response:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$THUNDERBOLT_API/v1/api/auth/api-key/delete" \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"keyId":"<key-id>"}'
```

Deletion revokes the key immediately. For a suspected compromise, revoke, replace the stored `THUNDERBOLT_TOKEN`, and issue a new key. `thunderbolt logout` only revokes the stored web session and its bound CLI device; it cannot remove a token from the process environment or revoke that PAT remotely.

API-key sessions and disabled per-key rate limiting are deliberate for headless automation. Account and IP-level limits still apply.
