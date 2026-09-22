# Chat Runtime

Everything between the user pressing Send and a finished assistant message
landing in SQLite. `src/chats/` is ~8,800 lines including tests, and dense with
non-obvious invariants: a single turn fans out across two engine families, three
retry layers, two spend budgets, three persistence writers and two telemetry
sinks — all while the UI has to stay honest about whether the turn is still
alive.

## Three things called "the chat"

They are easy to conflate and behave differently:

| Thing              | Lives in                                       | Lifetime                                                          |
| ------------------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| `Chat` instance    | `@ai-sdk/react`, built by `createChatInstance` | In memory, per thread id; owns the live message list and `status` |
| `ChatSession`      | Zustand, `src/chats/chat-store.ts`             | In memory, per thread id; owns everything the SDK has no slot for |
| `chat_threads` row | SQLite (synced)                                | Durable; created **lazily on the first message save**             |

`ChatSession` holds the `chatInstance`, the hydrated `chatThread` row (or
`null`), `connectionStatus`/`connectionError`, `retryCount`/`retriesExhausted`,
`stopping`, `pendingPermission`, `selectedAgent`, `selectedModel`, `projectId`
and `triggerData`.

The lazy row is the reason several fields live on the session rather than being
read back from the database. `getOrCreateChatThread` (`src/dal/chat-threads.ts`)
only runs inside `saveMessages`, so until the first user message is persisted
there is no row to carry the selected agent or the owning project. A brand-new
chat started from a project gets its `projectId` from the `?projectId=` search
param, and it has to survive on the session until that first save or the row
would be written with `project_id` null. Same for `selectedAgent`: the row is
created with `session.selectedAgent.id` so a reload does not silently fall back
to the built-in agent.

`useCurrentChatSession()` throws when no session exists. That is deliberate —
use it only in components that cannot render meaningfully without one; anything
optional reads the store directly with optional chaining.

## One send, end to end

Entry is `src/chats/detail.tsx` → `useHydrateChatStore` → `createChatInstance`.

1. **Hydration** (`src/chats/use-hydrate-chat-store.ts`). Redirects to
   `/not-found` for a soft-deleted thread, early-returns when the session
   already exists (refreshing the models list and the MCP getters and
   prewarming the built-in agent), and otherwise loads messages, models, agents
   and trigger data in one `Promise.all` before `createSession`. The agent is
   resolved through a fallback chain — the thread's persisted `agentId`, then
   the global `selected_agent` setting, then the first available agent, then
   `builtInAgent` — so a deployment with `disableBuiltInAgent`, or a deleted
   custom agent, degrades quietly instead of snapping every chat back to the
   built-in.
2. **Send.** `instance.sendMessage` is overridden in `createChatInstance`: it
   calls `startNewTurn()` (cancels any pending auto-retry, mints a fresh turn
   budget and telemetry, and clears the Stop suppression), rejects a model whose
   confidentiality does not match `chatThread.isEncrypted`, stamps `modelId` and
   debug-transcript metadata onto the message, and emits `chat_send_prompt`.
3. **Transport.** The instance is built with a single
   `DefaultChatTransport({ fetch: customFetch })`, where `customFetch` is
   `createAgentRoutingFetch`. Every send goes through it, for every agent type.
4. **Persist the user turn first.** Before the adapter is invoked,
   `customFetch` awaits `saveMessages`. This creates the `chat_threads` row,
   lets `updateThreadTitle` see the first user message and replace the
   placeholder title (ACP agents only emit assistant messages from `onFinish`,
   so a later save would be too late), navigates `/chats/new` → `/chats/<id>`,
   and guarantees the user turn is durable before the assistant stream opens.
5. **Route to an adapter.** `getOrConnectAdapter` resolves the agent's cached
   adapter (below). `connectionStatus` flips to `connecting` only when the
   routed agent differs from the last one this thread used.
6. **Fill in what the engine cannot see.** For non-built-in agents only,
   `customFetch` resolves `/slug` skill instructions and the project prompt
   section and passes them on the context — the built-in pipeline injects both
   itself in `src/ai/fetch.ts`, and ACP has no system channel. The project
   lookup is gated on `session.projectId`, so a loose chat never pays for it.
7. **Spend a request.** `turnBudget.tryConsumeRequest()` gates the call; denial
   throws the sentinel from `createTurnBudgetExhaustedError`, named
   `TurnBudgetExhaustedError` so both consuming layers classify it alike.
8. **Stream.** `adapter.fetch(init, ctx)` returns a `Response` whose body is an
   AI SDK v5 UI message stream. `wrapResponseForFirstContent` pipes it through
   a transform that enqueues every chunk unchanged while watching SSE lines for
   the first generated delta; the latch is one-shot, so after the first token
   the stream passes through undecoded.
9. **Settle.** `onFinish` runs the retry/abort/success ladder and the
   authoritative final save. `onError` only records — retry logic deliberately
   does **not** live there (earlier iterations looped, because `onFinish` resets
   the state `onError` depended on).

## Engine routing

There is one seam: `AgentAdapter` (`src/types/acp.ts`). The built-in agent is
not special-cased in the chat layer — it is an adapter like any other, produced
by `connectToAgent` (`src/acp/connect.ts`) and cached identically.

`src/acp/adapter-cache.ts` keeps **one adapter per agent, globally** — one
transport and one ACP `initialize` shared by every thread targeting that agent.
Per-thread state (the ACP session id, the permission handler, the side-effect
sink) travels on each `adapter.fetch` call instead, so one connection
multiplexes many threads without cross-thread bleed. Switching threads never
tears a connection down; only real teardown does — `disposeAdapter` on an agent
delete or a wire-identity change, `disposeAllAdapters` on sign-out. A terminated
generation is rebuilt whole — a new transport plus a new handshake — never by
swapping a transport under live JSON-RPC state, and the rebuild is scheduled by
`reconnect-scheduler.ts`. `wakeAdapterReconnect`, called on an explicit
regenerate (the Retry button, and `useChatAutomation`'s auto-run), collapses
that backoff.

Behind the built-in adapter there is a second routing decision, invisible to
`src/chats/`: `src/acp/built-in-adapter.ts` runs some models on the in-browser
Pi harness (lazily imported so its weight stays off the chat entry chunk) and
falls back to the legacy `aiFetchStreamingResponse` pipeline for the rest.
`isPiModelCandidate` (`built-in-adapter.ts:165`) decides: the provider must be
one of `anthropic`, `openai`, `custom`, `openrouter`, `thunderbolt` or
`tinfoil`, **and** the model must either be `tinfoil` or declare
`toolUsage !== 0`. So a model from a Pi-capable provider still takes the legacy
path when it reports no tool usage, and Tinfoil takes Pi unconditionally because
confidential inference has no legacy fallback. Turn telemetry records which one
ran as the turn's `engine`, whose only values are `pi` and `legacy`; an ACP turn
emits no turn telemetry and carries `acp` in its debug-transcript metadata
instead.

## Budgets and retries

Three independent limiters, in ascending scope:

| Limiter         | Where                        | Limit                                                         | Scope                         |
| --------------- | ---------------------------- | ------------------------------------------------------------- | ----------------------------- |
| Auto-retry      | `src/chats/chat-instance.ts` | `maxRetries = 3`, backoff `2000ms × 2^(n−1) × (0.5 + random)` | One logical turn              |
| Turn budget     | `src/ai/retry-budget.ts`     | `maxRequestsPerTurn = 6`, `maxTurnWallClockMs = 120_000`      | Every model request in a turn |
| Web tool budget | `src/ai/web-tool-budget.ts`  | `webToolCaps`: `auto` 5, `search` 12, `research` 30           | One logical turn              |

The turn budget is the backstop: _every_ request — first send, SDK-level retry,
empty-response retry, outer auto-retry — draws from it, so the layers above
cannot multiply into an unbounded spend. It is replaced when a turn starts,
succeeds or aborts, and deliberately **preserved** across auto-retries.

The web budget is keyed on `<last user message id>#<webToolBudgetRevision>` so
it survives auto-retries of the same prompt but is discarded on regenerate. Its
cap comes from `resolveWebToolIntent` reading the prompt's skill token, so
`/research` buys a wider budget than a bare question.

`onFinish` refuses to retry, in order, when: the error is
`connection-lost` (the agent may already have performed side effects — only the
user may resubmit); a rate limit (retrying makes it worse); a context overflow,
a content rejection, or anything the provider marked non-retryable (identical
input will not succeed, and a "Retrying…" spinner would be a lie); or the web
budget is spent (regeneration would discard the research already done). Content
rejections are excluded specifically because the attachment-remediation layer
owns re-delivery and surfaces the error itself once its ladder is exhausted.

The one fast path: an **empty turn** — no error, no parts — retries after
`emptyTurnRetryDelayMs` (250ms) on the first attempt rather than the full
backoff, because there is nothing to back off from.

A queued retry checks that the session still exists _and_ is still the current
session before firing; switching threads mid-backoff settles the turn as
aborted instead.

## Stop, and everything it has to suppress

This is the invariant most likely to bite. The AI SDK's
`sendAutomaticallyWhen` re-sends whenever the last message is a user message,
and it gates on `isError` only — not `isAbort`. Stopping a turn before the
assistant message materialized leaves exactly that shape, so without a guard the
cancelled turn immediately re-sends itself.

Hence `stopRequested` (closure) mirrored by `session.stopping` (store). Both are
set by `instance.stop` and cleared **only** by an explicit send or regenerate —
not by `onFinish`, which runs `resetRetryStateForNewTurn` on the aborted turn
itself and would re-open the very auto-sends the flags exist to block. Three
consumers depend on them:

- `sendAutomaticallyWhen` in `chat-instance.ts` (the SDK's own auto-send).
- `useChatAutomation` (`src/chats/use-chat-automation.tsx`), which auto-runs a
  thread ending in a user message — the shape automations produce, and also the
  shape a stopped turn leaves behind (THU-791).
- The composer's Stop spinner, via `getTurnActivity`, which masks `stopping`
  with a live request so a flag left behind by a turn that settled some other
  way cannot strand the button.

`instance.stop` also cancels any pending retry timer and resolves an open
permission dialog as `cancelled`, so no dialog outlives the turn that asked.
When the turn is in flight it delegates to the SDK and lets
`onFinish({ isAbort })` settle on the correct turn; when it is not (backoff, or
an empty-turn recovery spinner) there is no `onFinish`, so it settles inline.

`onFinish`'s abort branch repairs three shapes: an empty trailing assistant
shell is dropped from the live list (safe _only_ because `stopRequested` gates
the auto-send), a reasoning part left `streaming` is finalized so its spinner
stops, and a partial answer is persisted.

`getTurnActivity` (`src/chats/turn-activity.ts`) is a pure function precisely so
the thread's loading indicator and the composer's Stop button derive "is this
turn still doing something" from one place and cannot disagree.

## Persistence: three writers, one winner

| Writer                        | When                        | Path                                                              |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `saveMessages` (hydrate hook) | Before each send; on settle | Full: thread create, title generation, navigation, context update |
| `saveStreamingMessage`        | Every 500ms while streaming | Fast: no thread create, title or navigation; crash recovery only  |
| `onFinish` → `saveMessages`   | Success and abort           | Authoritative final save                                          |

`SavePartialAssistantMessagesHandler`
(`src/chats/save-partial-assistant-messages-handler.ts`) throttles its writes to
`streamingSaveThrottleMs = 500` because each one serializes the whole growing
message and, under E2EE, re-encrypts it. Its own `useChat` subscription is
intentionally *un*throttled: it renders nothing, so per-token cost is already
O(1), and throttling would only widen the window in which an aborted stream's
last partial goes unsaved.

Two terminal states are handled asymmetrically, and the asymmetry is the whole
point. On success or abort, `onFinish` performs the final save, so the handler
cancels its pending trailing write — otherwise a stale mid-stream snapshot would
land _after_ the authoritative one. On **error**, `onFinish` does not persist at
all, so the handler writes the freshest live message directly (the pending
trailing call holds an older delta's arguments). It also skips persisting an
empty assistant shell during streaming — that shell outlives the in-memory drop
an aborted turn performs, and would resurface on reload as a failed turn the
user had deliberately cancelled — except in the error branch, where the empty
trailing turn is exactly what hydration reads to show the failure.

## Permissions

ACP agents request tool permission over the wire; the built-in agent does not
(its tools auto-run by product decision, restoring the pre-#1032 baseline).
`requestPermissionViaStore` checks the remembered allowances — keyed by agent id
and, for the narrower grant, by the ACP tool _kind_ (`deriveToolKey`) — and
otherwise stores a `PendingPermission` on the session whose `resolve` is the
adapter's own promise resolver. `PermissionDialogHost` renders from that store
entry and completes the promise through `resolvePendingPermission`. Because the
resolver is stored rather than passed down, the dialog lives in the UI tree and
the awaiting code lives in a transport, with no prop path between them — and
adapter termination (`adapter-cache.ts`) can cancel every outstanding request
for an agent without knowing which components are mounted.

## Telemetry and debug transcripts

Two sinks, correlated by one trace id. `createTurnTelemetry`
(`src/ai/turn-telemetry.ts`) records a privacy-safe turn summary — phase
durations, first-token latency, retries by layer, tool timings, outcome —
emitted as `chat_turn_completed`. Built-in turns only: an ACP turn gets an
equivalent trace id without turn telemetry, since the phases are the agent's,
not ours.

A turn interrupted by a page reload would otherwise never emit. Markers are
written to `sessionStorage` under `thunderbolt_chat_turn_in_flight:<chatId>`,
and `createChatInstance` drains them on construction, reporting each as an
`abort`. The list holds multiple markers so overlapping turns survive while an
older final save settles.

The debug-transcript recorder (`src/debug-transcript/recorder.ts`) is the
opt-in, full-fidelity counterpart, hung off the same points:
`beginDebugTranscriptTurn` in `customFetch`, `recordDebugTranscriptRetry` at
each retry decision, `recordDebugTranscriptFailure` in `onError`, and
`finishDebugTranscriptTurn` on settle. When capture is enabled the metadata is
also stamped onto the saved message.

## Render throttling

Every streamed token notifies every `useChat` subscriber. `src/chats/chat-throttle.ts`
defines the three tiers used across the chat UI — `messageRenderThrottleMs` (40)
for visible message renderers, `messageBookkeepingThrottleMs` (150) for the
scroll handler, the composer and automation, and `statusOnlyThrottleMs` (500)
for subscribers that never read message content. `status` and `error` use
separate, unthrottled SDK subscriptions, so transitions stay instant at any
tier, and `onFinish` reads the `Chat` instance directly rather than a throttled
React snapshot — persistence is never affected by these numbers.
`smoothStreamWordDelayMs` (10) must stay at or below the render tier so a fresh
word is ready each paint.

## What must stay in step when you change send behaviour

- A new auto-send path must consult `stopping` (or `stopRequested`), or Stop
  stops working.
- A new request in the send path must draw from the turn budget, or it escapes
  the per-turn spend ceiling.
- A new terminal state must decide, explicitly, whether `onFinish` persists —
  the partial-save handler's cancel/direct-save branch is written against that
  answer.
- A new error class needs a retry verdict in `onFinish`'s ladder; the default
  (fall through and retry) is right only for transient failures.
- Anything read during a send that is not yet on the `chat_threads` row must
  live on `ChatSession`, because the row may not exist yet.
- Built-in and ACP diverge on system-channel content (skills, project context).
  A new injected section needs both paths, or it silently vanishes when the user
  switches agents.

## Source map

| Concern                                  | File                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Turn lifecycle, retries, stop, telemetry | `src/chats/chat-instance.ts`                                                       |
| Session state                            | `src/chats/chat-store.ts`                                                          |
| Hydration and the save functions         | `src/chats/use-hydrate-chat-store.ts`                                              |
| Route entry, new-chat id                 | `src/chats/detail.tsx`                                                             |
| Streaming crash-recovery saves           | `src/chats/save-partial-assistant-messages-handler.ts`                             |
| Derived turn state for the UI            | `src/chats/turn-activity.ts`                                                       |
| Auto-run for automations                 | `src/chats/use-chat-automation.tsx`                                                |
| Render throttle tiers                    | `src/chats/chat-throttle.ts`                                                       |
| Warming an ACP agent's slash commands    | `src/chats/use-warm-acp-commands.ts`                                               |
| Composer quote-reply channel             | `src/chats/pending-quotes-store.ts`                                                |
| Scrolling and scroll-to-message          | `src/chats/use-chat-scroll-handler.ts`, `src/chats/use-scroll-to-message.ts`       |
| Adapter contract                         | `src/types/acp.ts`                                                                 |
| Per-agent adapter cache and reconnect    | `src/acp/adapter-cache.ts`, `src/acp/reconnect-scheduler.ts`                       |
| Adapter construction                     | `src/acp/connect.ts`, `src/acp/built-in-adapter.ts`, `src/acp/acp-adapter.ts`      |
| Built-in model pipeline                  | `src/ai/fetch.ts`                                                                  |
| Budgets                                  | `src/ai/retry-budget.ts`, `src/ai/web-tool-budget.ts`, `src/ai/turn-web-budget.ts` |
| Error classification                     | `src/lib/error-utils.ts`                                                           |
| Turn telemetry                           | `src/ai/turn-telemetry.ts`                                                         |
| Debug transcripts                        | `src/debug-transcript/recorder.ts`                                                 |
| Permission dialog                        | `src/components/chat/permission-dialog-host.tsx`                                   |

## Related

- [Projects](./projects.md) — how a project's instructions reach a send, and
  why ACP agents get the prompt section but not the search tool.
- [Widgets](../features/widgets.md) — what the assistant's streamed text can
  render into.
