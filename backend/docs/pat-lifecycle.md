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

By default a PAT is refused on the confidential routes (`/v1/tinfoil/*` and the usage-receipt endpoint) with `403 WEB_LOGIN_REQUIRED`, and the CLI does not replay that failure through another provider. Set `CONFIDENTIAL_API_KEYS_ENABLED=true` to allow it.

The gate is an authorization choice, not a cryptographic one. Confidentiality comes from the caller: the Tinfoil SDK attests the enclave and HPKE-seals the body, and the proxy forwards ciphertext it cannot read. The `userCacheSecret` that partitions the enclave's prompt cache is generated client-side (`randomBytes(32)` in the CLI, `crypto.getRandomValues` in the browser) and never reaches the backend, so any PAT-authenticated caller can supply its own. What a PAT lacks is the device binding a web session carries, and it lives longer; confidential inference is metered against the account, so enabling the flag means accepting spend on that tier from a long-lived headless credential.

The CLI still requires `thunderbolt login` for confidential models regardless of the flag: `resolveAccountCredential` returns no cache secret on the PAT path, so `createTinfoilBinding` has nothing to namespace with. The flag is for service callers that manage their own cache secret, such as a backend using `tinfoil-python` with `base_url` pointed at `/v1/tinfoil`.

### Reporting usage from a service caller

The proxy forwards ciphertext it cannot read, so it cannot count tokens. The caller decrypts the response and reports the counts back; skipping this leaves the call out of the account's usage ledger, which is what the confidential-tier quota checks read. Every caller owes this step, but a service caller implements it by hand.

Send `X-Inference-Model` on the inference request so the receipt names the model you used. A request without it is priced as `glm-5-3`; an unrecognised value is rejected with 400 before anything reaches the enclave. Every successful managed chat completion answers with a signed receipt in the `X-Inference-Usage-Receipt` response header. Read it, decrypt the body, then POST the receipt with the counts:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$THUNDERBOLT_API/v1/inference-usage/receipts" \
  -H "x-api-key: $THUNDERBOLT_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"receipt":"<X-Inference-Usage-Receipt value>","promptTokens":412,"completionTokens":168,"totalTokens":580}'
```

The receipt signs `eventId`, `userId`, `provider`, `model` and the prices; the counts are yours and unsigned. It is valid for two hours, and replays of the same `eventId` are deduplicated, so retrying a submission you are unsure landed is safe.

Responses carry no body.

| Status       | Action                                           |
| ------------ | ------------------------------------------------ |
| `503`, `429` | Retry (`503` is a transient storage failure)     |
| `401`        | Keep the receipt, retry after credential refresh |
| `403`        | Drop it: the receipt belongs to another account  |
| `400`        | Drop it: malformed, expired, or out of range     |

Copy the shape of the CLI's `createUsageReceiptLifecycle` and `submitInferenceUsageReceipt` in `cli/src/provider-runtime/usage-receipt.ts`: receipts go to a durable on-disk outbox before the first attempt and are removed only once acknowledged, so a crash between the completion and the submission does not lose the usage.

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
