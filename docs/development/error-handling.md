# Error Handling

Functions throw, nothing catches, the failure surfaces loudly
([AGENTS.md](../../AGENTS.md#core-principles)). Three boundaries cannot:

| Boundary     | Convention                                 | Why it can't throw                                                            |
| ------------ | ------------------------------------------ | ----------------------------------------------------------------------------- |
| App boot     | `HandleResult<T>` with a `HandleErrorCode` | The code picks the recovery UI, and no error boundary sits above the pipeline |
| Chat turn    | A JSON envelope carrying a `ChatErrorKind` | The error is serialized to a string between the stream and the UI             |
| Backend HTTP | `ErrorResponse` from `safeErrorHandler`    | An internal message must never reach the client                               |

Everywhere else, throw.

## App boot: `HandleResult<T>`

[`src/types/handle-errors.ts`](../../src/types/handle-errors.ts): a success/error union plus an
error record carrying a closed 12-value code.

```ts
type HandleResult<T> = { success: true; data: T } | { success: false; error: HandleError }
```

- Returned by `executeInitializationSteps`
  ([`src/hooks/use-app-initialization.ts:173`](../../src/hooks/use-app-initialization.ts)) and
  `initPosthog` ([`src/lib/posthog.tsx:81`](../../src/lib/posthog.tsx)) only.
- `useAppInitialization` (`use-app-initialization.ts:428`) unwraps the first into `initData` /
  `initError`; [`src/app.tsx:343`](../../src/app.tsx) routes on `initError.code`.
- Build records with `createHandleError(code, message, originalError)`
  ([`src/lib/error-utils.ts:279`](../../src/lib/error-utils.ts)), never a literal: it lifts
  `originalError.stack` onto `stackTrace`, which feeds `AppErrorScreen`'s **Contact Support** mailto
  and the PostHog exception.

The code, not the message, picks the recovery path: `STORAGE_UNAVAILABLE` renders
`StorageUnavailableScreen`, everything else `AppErrorScreen`, which offers **Clear Local Database**
only for the two codes where wiping local data is the remedy
(`src/components/app-error-screen.tsx:48`). An unguarded throw from any step becomes
`UNKNOWN_ERROR` rather than a permanent spinner (`use-app-initialization.ts:450`).

### Which code means what

| Code                        | Produced by                                 | Outcome                                                                                                        |
| --------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `STORAGE_UNAVAILABLE`       | `use-app-initialization.ts:203`             | Fatal; dedicated storage screen                                                                                |
| `APP_DIR_CREATION_FAILED`   | `use-app-initialization.ts:214`             | Fatal; error screen                                                                                            |
| `DATABASE_INIT_FAILED`      | `use-app-initialization.ts:231`, `:253`     | Fatal; error screen with Clear Database                                                                        |
| `RECONCILE_DEFAULTS_FAILED` | `use-app-initialization.ts:343`             | Fatal; error screen                                                                                            |
| `HTTP_CLIENT_INIT_FAILED`   | `use-app-initialization.ts:381`             | Fatal; error screen                                                                                            |
| `UNKNOWN_ERROR`             | `use-app-initialization.ts:450`             | Fatal; error screen                                                                                            |
| `TRAY_INIT_FAILED`          | `use-app-initialization.ts:157`             | `trackError`, then swallowed; boot continues with no tray                                                      |
| `POSTHOG_FETCH_FAILED`      | `posthog.tsx:152`                           | Never tracked; `initializePostHog` (`use-app-initialization.ts:135`) discards it and substitutes a null client |
| `SYNC_ENABLE_FAILED`        | `src/contexts/sign-in-modal-context.tsx:85` | `trackError`, then swallowed; post-boot, not a boot step                                                       |
| `CANARY_EXTRACTION_FAILED`  | `src/services/encryption.ts:228`            | `trackError`, then rethrown to its caller; post-boot, not a boot step                                          |
| `MIGRATION_FAILED`          | no producer                                 | Consumed only; one of the two codes that show Clear Local Database                                             |
| `DATABASE_PATH_FAILED`      | no producer                                 | Genuinely dead outside stories and tests                                                                       |

**The call site decides fatality, not the code.** Nothing below `UNKNOWN_ERROR` reaches `initError`;
per-step fatality is tabulated in
[App Initialization](../architecture/app-initialization.md#the-steps-in-execution-order). Keep
`MIGRATION_FAILED`: removing it changes recovery for any future migration failure.

`trackError` (`src/lib/posthog.tsx:293`) reports the record as a PostHog exception keyed on the code
(`$exception_type`), dropping `POSTHOG_FETCH_FAILED` (analytics reporting its own failure is
circular). Boot sites add `initialization_step` so `DATABASE_INIT_FAILED`'s two producers stay
separable.

## Chat turns: `ChatErrorKind`

`serializeStreamError` ([`src/ai/fetch.ts:850`](../../src/ai/fetch.ts)) mints the envelope the client
parses back out:

```json
{ "error": "<responseBody or message>", "status": 400, "isRetryable": false, "kind": "provider" }
```

`ChatErrorKind` ([`src/lib/error-utils.ts:9`](../../src/lib/error-utils.ts)) is closed at six values:
`attestation`, `timeout`, `rate-limit`, `provider`, `network`, `connection-lost`. It needs an
envelope because the AI SDK's `onError` returns a string, flattening an `APICallError` to a bare
`"Bad Request"` and losing the status the retry and attachment-remediation layers need.

### One classifier, three wire shapes

`classifyErrorKind` (`src/lib/error-utils.ts:79`) reads error name, HTTP status and message (an
`APICallError`'s `responseBody` stands in) across three transports:

1. **A structured error object**, status on `status`, `statusCode` or `response.status`.
2. **Pi's flattened text**, already collapsed into a string by pi-ai's `formatProviderError`.
   `getPiErrorStatusCode` (`:47`) recovers the status from `"<status>: <body>"`,
   `"<prefix> (<status>): <message>"`, or `"<status> <JSON body>"`.
3. **JSON inside `Error.message`**, the envelope above. `getChatErrorKind` (`:115`) parses it and
   **trusts** a valid `kind` rather than re-deriving; older payloads predate the field, so it falls
   back to re-classifying from the embedded status and message.

That trust is load-bearing: `connection-lost` is the one kind `classifyErrorKind` never produces, so
the ACP adapter mints it pre-serialized when a transport dies
([`src/acp/acp-adapter.ts:407`](../../src/acp/acp-adapter.ts)). No HTTP status marks a dropped agent
socket, and the agent may already have performed side effects.

**400 and 422 fold into `provider` deliberately**: there is no content-rejection bucket, so a
rejected file part reports as a provider problem (`src/lib/error-utils.ts:97`). Attachment
remediation uses a separate predicate ([Attachments](../architecture/attachments.md)).

### Predicates: what to do next

| Predicate                 | Question                                                    |
| ------------------------- | ----------------------------------------------------------- |
| `isRateLimitError`        | A 429, on any of the three wire shapes                      |
| `getInferenceQuotaWindow` | A managed-inference quota rejection, and which window       |
| `isContextOverflowError`  | Request too large for the model's context window            |
| `isContentRejectionError` | The endpoint rejected the _form_ of a file part (400/422)   |
| `getErrorRetryable`       | The provider's own retry verdict, when it survived the wire |

The retry ladder in `src/chats/chat-instance.ts` consults these one at a time instead of switching on
the kind; `connection-lost` is the exception, checked as a kind (`chat-instance.ts:915`) because no
predicate covers it. `getErrorRetryable` exists because "is it a 4xx" buckets a transient 408 with a
deterministic 400. Full ladder: [Chat Runtime](../architecture/chat-runtime.md#budgets-and-retries).

### What must stay in step

- **Adding a `ChatErrorKind` needs copy.** `causeSpecificErrorMessages`
  ([`src/components/chat/error-message.tsx:21`](../../src/components/chat/error-message.tsx)) is a
  `Partial<Record<…>>`, so a missing entry compiles and silently renders "Something went wrong". It
  also needs a retry verdict in `chat-instance.ts`; the default is retry, right only for transient
  failures.
- **Changing `classifyErrorKind` changes telemetry.** The retry `reason` on `chat_auto_retry` /
  `chat_retries_exhausted` and the `kind` on `chat_turn_error` derive from it; update
  [TELEMETRY.md](../../TELEMETRY.md#chat--messaging-chat_), which maps it status by status, in the
  same PR.

## Backend: never leak internals

`safeErrorHandler`
([`backend/src/middleware/error-handling.ts:69`](../../backend/src/middleware/error-handling.ts)) is
the Elysia `onError` handler route modules install; it returns `{ success: false, data: null, error }`.

- `error` is `getSafeErrorMessage(status)`: Elysia's standard HTTP reason phrase from
  `InvertedStatusMap`, never the thrown message. Internal detail goes to the log, with status, route,
  stack and cause chain.
- `VALIDATION` and `NOT_FOUND` return early and let Elysia's defaults handle them; that output is
  already user-facing and safe.
- `getSafeLogMessage` (`:40`) special-cases `DrizzleQueryError`: Drizzle interpolates parameter
  values (emails, tokens) into `.message`, so the handler logs the parameterized `.query` instead. A
  new log line reaching for `error.message` reintroduces that leak.
- The root `createErrorHandlingMiddleware` does **not** cover routes defined on plugins, so nearly
  every route module calls `.onError(safeErrorHandler)` itself. Plugin checklist:
  [Backend API Surface](../architecture/backend-api-surface.md).

## There is no React error boundary

No component in `src/` implements `componentDidCatch` and no error-boundary package is a dependency;
the only boundary is a test fixture in `src/components/auth-gate/use-auth-gate.test.ts`. Outside the
boot pipeline a render-time throw reaches the React root, unmounting the tree into a blank window.
Async work in a handler or effect rejects instead of unmounting.

## Where the code lives

| File                                                                                                   | Role                                                     |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| [`src/types/handle-errors.ts`](../../src/types/handle-errors.ts)                                       | `HandleErrorCode`, `HandleError`, `HandleResult`         |
| [`src/lib/error-utils.ts`](../../src/lib/error-utils.ts)                                               | `createHandleError`, `ChatErrorKind`, every predicate    |
| [`src/lib/error-utils.test.ts`](../../src/lib/error-utils.test.ts)                                     | Wire-shape corpus; add a case for any new shape          |
| [`src/hooks/use-app-initialization.ts`](../../src/hooks/use-app-initialization.ts)                     | The boot pipeline and its per-step error codes           |
| [`src/components/app-error-screen.tsx`](../../src/components/app-error-screen.tsx)                     | Fatal-boot UI, Clear Database, support mailto            |
| [`src/components/storage-unavailable-screen.tsx`](../../src/components/storage-unavailable-screen.tsx) | The `STORAGE_UNAVAILABLE` screen                         |
| [`src/lib/posthog.tsx`](../../src/lib/posthog.tsx)                                                     | `trackError` and the circular-tracking guard             |
| [`src/ai/fetch.ts`](../../src/ai/fetch.ts)                                                             | `serializeStreamError`, where the envelope is minted     |
| [`src/components/chat/error-message.tsx`](../../src/components/chat/error-message.tsx)                 | Per-kind chat copy and the Retry affordance              |
| [`backend/src/middleware/error-handling.ts`](../../backend/src/middleware/error-handling.ts)           | `safeErrorHandler`, `getSafeErrorMessage`, log redaction |
