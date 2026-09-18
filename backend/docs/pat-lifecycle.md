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

### Reporting usage from a service caller

Pointing an SDK at the proxy gets you a working response, but not a metered one.
The proxy forwards ciphertext it cannot read, so it cannot count tokens; the caller
decrypts the response and reports the counts back. Skipping this leaves the call out
of the account's usage ledger, which is what the confidential-tier quota checks read.
The step is the caller's regardless of credential — a web session owes it too — but a
service caller is the one that has to implement it by hand.

Send `X-Inference-Model` on the inference request so the receipt names the model you
actually used; a request without it is priced as `glm-5-3`, and an unrecognised value
is rejected with 400 before anything reaches the enclave. Every successful managed
chat completion answers with a signed receipt in the `X-Inference-Usage-Receipt`
response header. Read it, decrypt the body, then POST the receipt with the counts:

```bash
curl --fail-with-body --silent --show-error \
  -X POST "$THUNDERBOLT_API/v1/inference-usage/receipts" \
  -H "x-api-key: $THUNDERBOLT_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"receipt":"<X-Inference-Usage-Receipt value>","promptTokens":412,"completionTokens":168,"totalTokens":580}'
```

The receipt signs `eventId`, `userId`, `provider`, `model` and the prices; the counts
are yours and are not covered by the signature. It is valid for two hours, and replays
of the same `eventId` are deduplicated, so retrying a submission you are unsure landed
is safe.

Responses carry no body. Retry on `503` (transient storage failure) and on `429`; keep
the receipt and retry later on `401` (credential refresh); drop it on `403`, which
means the receipt belongs to another account and can never succeed for this one. A
`400` is a malformed, expired, or out-of-range submission and will not become valid.

The CLI's implementation is `createUsageReceiptLifecycle` and
`submitInferenceUsageReceipt` in `cli/src/provider-runtime/usage-receipt.ts`. It is
worth copying the shape: receipts go to a durable on-disk outbox before the first
attempt and are removed only once acknowledged, so a crash between the completion and
the submission does not silently lose the usage.

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
