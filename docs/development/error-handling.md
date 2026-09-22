# Error Handling

[AGENTS.md](../../AGENTS.md#core-principles) says to prefer optimistic code over defensive code and to
handle errors architecturally at higher levels. Almost all of the codebase follows that literally:
functions throw, nothing catches, and the failure surfaces loudly. Three boundaries are exceptions,
and each has its own convention because each has a reason it cannot just throw:

| Boundary     | Convention                                 | Why it can't throw                                                                       |
| ------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| App boot     | `HandleResult<T>` with a `HandleErrorCode` | The recovery UI is chosen by the code, and there is no error boundary above the pipeline |
| Chat turn    | A JSON envelope carrying a `ChatErrorKind` | The error is serialized to a string on its way from the stream to the UI                 |
| Backend HTTP | `ErrorResponse` from `safeErrorHandler`    | An internal message must never reach the client                                          |

Everywhere else, throw.

## App boot: `HandleResult<T>`

[`src/types/handle-errors.ts`](../../src/types/handle-errors.ts) defines a success/error
discriminated union, an error record carrying a closed 12-value code, and nothing else:

```ts
type HandleResult<T> = { success: true; data: T } | { success: false; error: HandleError }
```

Exactly two functions return it: `executeInitializationSteps`
([`src/hooks/use-app-initialization.ts:173`](../../src/hooks/use-app-initialization.ts)) and
`initPosthog` ([`src/lib/posthog.tsx:81`](../../src/lib/posthog.tsx)). `useAppInitialization`
(`src/hooks/use-app-initialization.ts:428`) unwraps the first into `initData` / `initError`, and
[`src/app.tsx:343`](../../src/app.tsx) routes on `initError.code`.

The union earns its place here because the code — not the message — selects the recovery path.
`STORAGE_UNAVAILABLE` renders `StorageUnavailableScreen`; everything else renders `AppErrorScreen`,
which offers **Clear Local Database** only for the two codes where wiping local data is the actual
remedy (`src/components/app-error-screen.tsx:48`). A thrown `Error` carries none of that. The hook
does still catch: an unguarded throw from any step becomes `UNKNOWN_ERROR` rather than a permanent
loading spinner (`src/hooks/use-app-initialization.ts:450`).

Build the record with `createHandleError(code, message, originalError)`
([`src/lib/error-utils.ts:279`](../../src/lib/error-utils.ts)) rather than a literal — it lifts
`originalError.stack` onto `stackTrace`, which is what `AppErrorScreen`'s **Contact Support**
mailto and the PostHog exception both report.

### The codes

| Code                        | Produced by                                 | Effect                                   |
| --------------------------- | ------------------------------------------- | ---------------------------------------- |
| `STORAGE_UNAVAILABLE`       | `use-app-initialization.ts:203`             | Fatal — dedicated storage screen         |
| `APP_DIR_CREATION_FAILED`   | `use-app-initialization.ts:214`             | Fatal — error screen                     |
| `DATABASE_INIT_FAILED`      | `use-app-initialization.ts:231`, `:253`     | Fatal — error screen with Clear Database |
| `RECONCILE_DEFAULTS_FAILED` | `use-app-initialization.ts:343`             | Fatal — error screen                     |
| `HTTP_CLIENT_INIT_FAILED`   | `use-app-initialization.ts:381`             | Fatal — error screen                     |
| `UNKNOWN_ERROR`             | `use-app-initialization.ts:450`             | Fatal — error screen                     |
| `TRAY_INIT_FAILED`          | `use-app-initialization.ts:157`             | Tracked; boot continues with no tray     |
| `POSTHOG_FETCH_FAILED`      | `posthog.tsx:152`                           | Returned, then dropped; null client      |
| `SYNC_ENABLE_FAILED`        | `src/contexts/sign-in-modal-context.tsx:85` | Tracked and swallowed; post-boot         |
| `CANARY_EXTRACTION_FAILED`  | `src/services/encryption.ts:228`            | Tracked, then rethrown; post-boot        |
| `MIGRATION_FAILED`          | no producer                                 | Consumed — see below                     |
| `DATABASE_PATH_FAILED`      | no producer                                 | Unused outside stories and tests         |

**A code does not tell you whether a failure is fatal; the call site does.** Nothing in the bottom
half of the table reaches `initError`, but they do not all end the same way: `TRAY_INIT_FAILED` and
`SYNC_ENABLE_FAILED` are handed to `trackError` and swallowed, `CANARY_EXTRACTION_FAILED` is tracked
and then rethrown to its caller, and `POSTHOG_FETCH_FAILED` is the one code that travels in a
`HandleResult` without ever being tracked — `initializePostHog`
(`src/hooks/use-app-initialization.ts:135`) unwraps it, discards the error and substitutes a null
client. The last two are not boot steps at all. Which boot steps are fatal and which are swallowed is
set by the pipeline, and is tabulated in
[App Initialization](../architecture/app-initialization.md#the-steps-in-execution-order).

`MIGRATION_FAILED` has no producer but is load-bearing on the consumer side: it is one of the two
codes that show the Clear Local Database button, so removing it changes recovery behaviour for any
future migration failure. `DATABASE_PATH_FAILED` is genuinely dead.

`trackError` (`src/lib/posthog.tsx:293`) captures the record as a PostHog exception, keyed on the
code as `$exception_type`. It drops `POSTHOG_FETCH_FAILED` — reporting an analytics failure through
analytics is circular. Boot call sites pass an `initialization_step` context property so a code that
has two producers (`DATABASE_INIT_FAILED`) stays separable on the dashboard.

## Chat turns: `ChatErrorKind`

A failed turn's error has to cross a string boundary. The AI SDK's `onError` callback returns a
string, and the SDK flattens an `APICallError` to a bare `"Bad Request"` — losing the status code the
retry and attachment-remediation layers need. So `serializeStreamError`
([`src/ai/fetch.ts:850`](../../src/ai/fetch.ts)) mints a JSON envelope instead, and the client parses
it back out:

```json
{ "error": "<responseBody or message>", "status": 400, "isRetryable": false, "kind": "provider" }
```

`ChatErrorKind` ([`src/lib/error-utils.ts:9`](../../src/lib/error-utils.ts)) is the six-value closed
set of user-facing classes: `attestation`, `timeout`, `rate-limit`, `provider`, `network`,
`connection-lost`.

### One classifier, three wire shapes

`classifyErrorKind` (`src/lib/error-utils.ts:79`) classifies from three normalized fields — error
name, HTTP status, and message, where an `APICallError`'s `responseBody` stands in for the message —
and has to cope with three different shapes because errors reach it from three transports:

1. **A structured error object**, where the status is on `status`, `statusCode` or `response.status`.
2. **Pi's flattened text**, where pi-ai's `formatProviderError` has already collapsed the response
   into a string. `getPiErrorStatusCode` (`:47`) recovers the status from `"<status>: <body>"`,
   `"<prefix> (<status>): <message>"`, or `"<status> <JSON body>"`.
3. **JSON inside `Error.message`** — the envelope above. `getChatErrorKind` (`:115`) parses it, and
   if it carries a valid `kind` it **trusts it** rather than re-deriving; otherwise it re-classifies
   from the embedded status and message. Older payloads predate the `kind` field, which is why the
   fallback exists.

That trust is not incidental: `connection-lost` is the one kind `classifyErrorKind` never produces.
It is minted pre-serialized by the ACP adapter when a transport dies
([`src/acp/acp-adapter.ts:407`](../../src/acp/acp-adapter.ts)), because no HTTP status distinguishes
"the agent's socket dropped mid-turn" from any other failure — and the distinction matters, since the
agent may already have performed side effects.

**400 and 422 are deliberately folded into `provider`.** `ChatErrorKind` has no content-rejection
bucket, so a rejected file part reports as a provider problem (`src/lib/error-utils.ts:97`). The
narrow signal that drives attachment remediation is a separate predicate — see
[Attachments](../architecture/attachments.md).

### The predicates around it

The kind answers "what do we tell the user". These answer "what do we do next", and the retry ladder
in `src/chats/chat-instance.ts` consults them one at a time rather than switching on the kind.
`connection-lost` is the single exception — it is checked as a kind (`src/chats/chat-instance.ts:915`)
because no predicate covers it:

| Predicate                 | Question                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `isRateLimitError`        | A 429, on any of the three wire shapes                      |
| `getInferenceQuotaWindow` | A managed-inference quota rejection, and which window       |
| `isContextOverflowError`  | Request too large for the model's context window            |
| `isContentRejectionError` | The endpoint rejected the _form_ of a file part (400/422)   |
| `getErrorRetryable`       | The provider's own retry verdict, when it survived the wire |

`getErrorRetryable` exists because "is it a 4xx" is the wrong question — it buckets a transient 408
with a deterministic 400. The full retry ladder, including the order these are checked in and why
each one refuses to retry, is in
[Chat Runtime](../architecture/chat-runtime.md#budgets-and-retries).

### What must stay in step

- **Adding a `ChatErrorKind` needs copy.** `causeSpecificErrorMessages`
  ([`src/components/chat/error-message.tsx:21`](../../src/components/chat/error-message.tsx)) is a
  `Partial<Record<…>>`, so a missing entry compiles and silently renders the generic "Something went
  wrong" instead. It also needs a retry verdict in `chat-instance.ts` — the default is to retry,
  which is right only for transient failures.
- **Changing `classifyErrorKind` changes telemetry.** The retry `reason` on `chat_auto_retry` /
  `chat_retries_exhausted` and the `kind` on `chat_turn_error` are derived from it, and
  [TELEMETRY.md](../../TELEMETRY.md#chat--messaging-chat_) spells the mapping out status by status.
  Update it in the same PR, or the dashboards document a classifier that no longer exists.

## Backend: never leak internals

`safeErrorHandler` ([`backend/src/middleware/error-handling.ts:69`](../../backend/src/middleware/error-handling.ts))
is the Elysia `onError` handler the route modules install. It returns a fixed shape —
`{ success: false, data: null, error }` — where `error` is `getSafeErrorMessage(status)`: the
standard HTTP reason phrase from Elysia's `InvertedStatusMap`, never the thrown message. The
internal detail goes to the log instead, with the status, route, stack and cause chain.

Two deliberate pass-throughs: `VALIDATION` and `NOT_FOUND` return early and let Elysia's defaults
handle them, because that output is already user-facing and safe.

Logging goes through `getSafeLogMessage` (`:40`), which special-cases `DrizzleQueryError`:
Drizzle interpolates parameter values — emails, tokens — into `.message`, so the handler logs the
structured `.query` (parameterized SQL) instead. Reaching for `error.message` in a new backend log
line reintroduces that leak.

The root `createErrorHandlingMiddleware` does **not** cover routes defined on plugins, which is why
nearly every route module calls `.onError(safeErrorHandler)` itself. See
[Backend API Surface](../architecture/backend-api-surface.md) for the full plugin checklist.

## There is no React error boundary

No component in `src/` implements `componentDidCatch`, and no error-boundary package is a
dependency — the only boundary in the repo is a fixture local to
`src/components/auth-gate/use-auth-gate.test.ts`. Outside the boot pipeline there is therefore
nothing between a render-time throw and the React root, which unmounts the tree and leaves a blank
window. Async work in an event handler or effect is fine — that rejects, it does not unmount — but
code evaluated during render should not assume something will catch it.

## Where the code lives

| File                                                                                                   | Role                                                     |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [`src/types/handle-errors.ts`](../../src/types/handle-errors.ts)                                       | `HandleErrorCode`, `HandleError`, `HandleResult`         |
| [`src/lib/error-utils.ts`](../../src/lib/error-utils.ts)                                               | `createHandleError`, `ChatErrorKind`, every predicate    |
| [`src/lib/error-utils.test.ts`](../../src/lib/error-utils.test.ts)                                     | The wire-shape corpus — add a case for any new shape     |
| [`src/hooks/use-app-initialization.ts`](../../src/hooks/use-app-initialization.ts)                     | The boot pipeline and its per-step error codes           |
| [`src/components/app-error-screen.tsx`](../../src/components/app-error-screen.tsx)                     | Fatal-boot UI, Clear Database, support mailto            |
| [`src/components/storage-unavailable-screen.tsx`](../../src/components/storage-unavailable-screen.tsx) | The `STORAGE_UNAVAILABLE` screen                         |
| [`src/lib/posthog.tsx`](../../src/lib/posthog.tsx)                                                     | `trackError` and the circular-tracking guard             |
| [`src/ai/fetch.ts`](../../src/ai/fetch.ts)                                                             | `serializeStreamError` — where the envelope is minted    |
| [`src/components/chat/error-message.tsx`](../../src/components/chat/error-message.tsx)                 | Per-kind chat copy and the Retry affordance              |
| [`backend/src/middleware/error-handling.ts`](../../backend/src/middleware/error-handling.ts)           | `safeErrorHandler`, `getSafeErrorMessage`, log redaction |
