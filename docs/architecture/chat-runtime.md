# Chat Runtime

Everything between Send and a finished assistant message landing in SQLite: two
engine families, three retry layers, two spend budgets, three persistence
writers, two telemetry sinks (`src/chats/`, ~8,800 lines including tests).

## Three things called "the chat"

| Thing              | Lives in                                       | Lifetime                                                          |
| ------------------ | ---------------------------------------------- | ----------------------------------------------------------------- |
| `Chat` instance    | `@ai-sdk/react`, built by `createChatInstance` | In memory, per thread id; owns the live message list and `status` |
| `ChatSession`      | Zustand, `src/chats/chat-store.ts`             | In memory, per thread id; owns everything the SDK has no slot for |
| `chat_threads` row | SQLite (synced)                                | Durable; created **lazily on the first message save**             |

`ChatSession` holds `chatInstance`, the hydrated `chatThread` row (or `null`),
`connectionStatus`/`connectionError`, `retryCount`/`retriesExhausted`,
`stopping`, `pendingPermission`, `selectedAgent`, `selectedModel`, `projectId`
and `triggerData`.

`getOrCreateChatThread` (`src/dal/chat-threads.ts`) runs only inside
`saveMessages`, so before the first save there is no row to read back. Hence
`projectId` (from `?projectId=`, or the row gets `project_id` null) and
`selectedAgent` (the row is created with `session.selectedAgent.id`, so a reload
keeps the agent) live on the session.

`useCurrentChatSession()` throws when no session exists. Use it only in
components that cannot render without one; everything else reads the store with
optional chaining.

## One send, end to end

Entry is `src/chats/detail.tsx` → `useHydrateChatStore` → `createChatInstance`.

1. **Hydration** (`src/chats/use-hydrate-chat-store.ts`). A soft-deleted thread
   redirects to `/not-found`. Existing session: refresh models and MCP getters,
   prewarm the built-in agent, return. Otherwise one `Promise.all` for messages,
   models, agents and trigger data, then `createSession`. Agent fallback chain:
   thread `agentId` → `selected_agent` setting → first available agent →
   `builtInAgent`, so `disableBuiltInAgent` deployments and deleted custom
   agents degrade quietly.
2. **Send.** `createChatInstance` overrides `instance.sendMessage`:
   `startNewTurn()` (cancel any pending auto-retry, mint a turn budget and
   telemetry, clear the Stop suppression), reject a model whose confidentiality
   mismatches `chatThread.isEncrypted`, stamp `modelId` and debug-transcript
   metadata on the message, emit `chat_send_prompt`.
3. **Transport.** One `DefaultChatTransport({ fetch: customFetch })`, where
   `customFetch` is `createAgentRoutingFetch`. Every send, every agent type.
4. **Persist the user turn first.** `customFetch` awaits `saveMessages` before
   the adapter runs: creates the row, lets `updateThreadTitle` replace the
   placeholder title from the first user message (ACP agents emit assistant
   messages only from `onFinish`, too late), navigates `/chats/new` →
   `/chats/<id>`, and makes the turn durable before the stream opens.
5. **Route.** `getOrConnectAdapter` resolves the agent's cached adapter.
   `connectionStatus` flips to `connecting` only when the routed agent differs
   from this thread's last one.
6. **Fill in what the engine cannot see.** Non-built-in agents only:
   `customFetch` puts `/slug` skill instructions and the project prompt section
   on the context. The built-in pipeline injects both itself in
   `src/ai/fetch.ts`, and ACP has no system channel. The project lookup is gated
   on `session.projectId`.
7. **Spend a request.** `turnBudget.tryConsumeRequest()` gates the call; denial
   throws the sentinel from `createTurnBudgetExhaustedError`, named
   `TurnBudgetExhaustedError` so both consuming layers classify it alike.
8. **Stream.** `adapter.fetch(init, ctx)` returns a `Response` carrying an AI SDK
   v5 UI message stream. `wrapResponseForFirstContent` enqueues chunks unchanged
   while watching SSE lines for the first generated delta; the latch is
   one-shot, so later chunks pass through undecoded.
9. **Settle.** `onFinish` runs the retry/abort/success ladder and the
   authoritative final save. `onError` only records: retry logic there looped,
   because `onFinish` resets the state `onError` depended on.

## Engine routing

One seam: `AgentAdapter` (`src/types/acp.ts`). The built-in agent is not
special-cased in the chat layer; it is an adapter produced by `connectToAgent`
(`src/acp/connect.ts`) and cached like any other.

### Adapter cache

`src/acp/adapter-cache.ts` keeps **one adapter per agent, globally**: one
transport and one ACP `initialize` shared by every thread targeting that agent.
Per-thread state (ACP session id, permission handler, side-effect sink) travels
on each `adapter.fetch` call, so one connection multiplexes many threads without
cross-thread bleed.

Switching threads never tears a connection down. Only `disposeAdapter` (agent
delete, wire-identity change), `disposeAllAdapters` (sign-out) and a terminated
generation's rebuild do. That rebuild is whole, a new transport plus a new
handshake, never a swap under live JSON-RPC state
([acp-agents.md](./acp-agents.md#the-generation-invariant)). It is scheduled by
`reconnect-scheduler.ts`; `wakeAdapterReconnect` collapses the backoff on an
explicit regenerate (the Retry button, `useChatAutomation`'s auto-run).

### Pi versus legacy, behind the built-in adapter

`src/acp/built-in-adapter.ts` runs some models on the in-browser Pi harness
(lazily imported to keep its weight off the chat entry chunk) and the legacy
`aiFetchStreamingResponse` pipeline for the rest. Invisible to `src/chats/`.

`isPiModelCandidate` (`built-in-adapter.ts:165`) takes Pi when **both** hold:

- the provider is `anthropic`, `openai`, `custom`, `openrouter`, `thunderbolt`
  or `tinfoil`, **and**
- the model is `tinfoil` or declares `toolUsage !== 0`.

Tinfoil takes Pi unconditionally because confidential inference has no legacy
fallback. Turn telemetry records which ran as the turn's `engine` (`pi` or
`legacy`); an ACP turn emits no turn telemetry and carries `acp` in its
debug-transcript metadata instead.

## Budgets and retries

| Limiter         | Where                        | Limit                                                         | Scope                         |
| --------------- | ---------------------------- | ------------------------------------------------------------- | ----------------------------- |
| Auto-retry      | `src/chats/chat-instance.ts` | `maxRetries = 3`, backoff `2000ms × 2^(n−1) × (0.5 + random)` | One logical turn              |
| Turn budget     | `src/ai/retry-budget.ts`     | `maxRequestsPerTurn = 6`, `maxTurnWallClockMs = 120_000`      | Every model request in a turn |
| Web tool budget | `src/ai/web-tool-budget.ts`  | `webToolCaps`: `auto` 5, `search` 12, `research` 30           | One logical turn              |

The turn budget is the backstop: _every_ request (first send, SDK-level retry,
empty-response retry, outer auto-retry) draws from it, so the layers above
cannot multiply into unbounded spend. Replaced when a turn starts, succeeds or
aborts; deliberately **preserved** across auto-retries.

The web budget is keyed on `<last user message id>#<webToolBudgetRevision>`, so
it survives auto-retries of the same prompt and is discarded on regenerate. Its
cap comes from `resolveWebToolIntent`, reading the prompt's skill token.

### When `onFinish` refuses to retry

Checked in this order:

| Case                                                                               | Why not                                                                        |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `connection-lost`                                                                  | The agent may already have performed side effects; only the user may resubmit. |
| Rate limit                                                                         | Retrying makes it worse.                                                       |
| Context overflow, content rejection, or anything the provider marked non-retryable | Identical input will not succeed, and a "Retrying…" spinner would be a lie.    |
| Web budget spent                                                                   | Regeneration would discard the research already done.                          |

Content rejections are excluded because attachment remediation owns re-delivery
and surfaces the error itself once its ladder is exhausted.

One fast path: an **empty turn** (no error, no parts) retries after
`emptyTurnRetryDelayMs` (250ms) on the first attempt, not the full backoff. A
queued retry checks that the session still exists _and_ is still current;
switching threads mid-backoff settles the turn as aborted.

## Stop, and everything it has to suppress

The AI SDK's `sendAutomaticallyWhen` re-sends whenever the last message is a
user message, gating on `isError` and not `isAbort`. A turn stopped before its assistant
message materialized leaves exactly that shape, so unguarded it re-sends itself.

Hence `stopRequested` (closure) mirrored by `session.stopping` (store), set by
`instance.stop` and cleared **only** by an explicit send or regenerate. Never by
`onFinish`: it runs `resetRetryStateForNewTurn` on the aborted turn and would
re-open the auto-sends the flags block. Consumers:

- `sendAutomaticallyWhen` in `chat-instance.ts`.
- `useChatAutomation` (`src/chats/use-chat-automation.tsx`), which auto-runs a
  thread ending in a user message: what automations produce, and what a stopped
  turn leaves behind (THU-791).
- The composer's Stop spinner, via the pure `getTurnActivity`
  (`src/chats/turn-activity.ts`), which masks `stopping` with a live request so
  a stale flag cannot strand the button. The thread's loading indicator derives
  from the same function, so the two cannot disagree.

`instance.stop` also cancels any pending retry timer and resolves an open
permission dialog as `cancelled`. In flight it delegates to the SDK, letting
`onFinish({ isAbort })` settle the right turn; otherwise (backoff, empty-turn
recovery spinner) it settles inline.

`onFinish`'s abort branch drops an empty trailing assistant shell from the live
list (safe _only_ because `stopRequested` gates the auto-send), finalizes a
reasoning part left `streaming`, and persists a partial answer.

## Persistence: three writers, one winner

| Writer                        | When                        | Path                                                              |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `saveMessages` (hydrate hook) | Before each send; on settle | Full: thread create, title generation, navigation, context update |
| `saveStreamingMessage`        | Every 500ms while streaming | Fast: no thread create, title or navigation; crash recovery only  |
| `onFinish` → `saveMessages`   | Success and abort           | Authoritative final save                                          |

`SavePartialAssistantMessagesHandler`
(`src/chats/save-partial-assistant-messages-handler.ts`) throttles writes to
`streamingSaveThrottleMs = 500` because each one serializes the whole growing
message and, under E2EE, re-encrypts it. Its own `useChat` subscription is
unthrottled on purpose: it renders nothing, so per-token cost is already O(1),
and throttling would widen the window in which an aborted stream's last partial
goes unsaved.

- **Success or abort**: `onFinish` saves, so the handler cancels its pending
  trailing write; otherwise a stale mid-stream snapshot lands _after_ the
  authoritative one.
- **Error**: `onFinish` does not persist, so the handler writes the freshest
  live message directly (the pending trailing call holds older arguments).

During streaming the handler skips an empty assistant shell: it outlives the
in-memory drop an aborted turn performs, and would resurface on reload as a
failed turn the user cancelled. The error branch is the exception, where that
shell is what hydration reads to show the failure.

## Permissions

ACP agents request tool permission over the wire; built-in tools auto-run by
product decision, restoring the pre-#1032 baseline.

`requestPermissionViaStore` checks remembered allowances, keyed by agent id and,
for the narrower grant, by ACP tool _kind_ (`deriveToolKey`). Otherwise it
stores a `PendingPermission` on the session whose `resolve` is the adapter's own
promise resolver; `PermissionDialogHost` renders that entry and completes the
promise through `resolvePendingPermission`.

Storing the resolver keeps the dialog in the UI tree while the awaiting code
sits in a transport with no prop path between them, and lets adapter termination
(`adapter-cache.ts`) cancel every outstanding request for an agent without
knowing what is mounted.

## Telemetry and debug transcripts

Two sinks, correlated by one trace id.

**Turn telemetry.** `createTurnTelemetry` (`src/ai/turn-telemetry.ts`) emits
`chat_turn_completed` with a privacy-safe summary: phase durations, first-token
latency, retries by layer, tool timings, outcome. Built-in turns only; an ACP
turn gets a trace id but no turn telemetry, since the phases are the agent's.

A reload would otherwise lose an in-flight turn, so markers go to
`sessionStorage` under `thunderbolt_chat_turn_in_flight:<chatId>` and
`createChatInstance` drains them on construction, reporting each as an `abort`.
The list holds multiple markers so overlapping turns survive while an older
final save settles.

**Debug transcripts.** `src/debug-transcript/recorder.ts`, opt-in and
full-fidelity, hangs off the same points. With capture on, the metadata is also
stamped onto the saved message.

| Hook                           | Where               |
| ------------------------------ | ------------------- |
| `beginDebugTranscriptTurn`     | `customFetch`       |
| `recordDebugTranscriptRetry`   | each retry decision |
| `recordDebugTranscriptFailure` | `onError`           |
| `finishDebugTranscriptTurn`    | on settle           |

## Render throttling

Every streamed token notifies every `useChat` subscriber.
`src/chats/chat-throttle.ts` defines three tiers:

| Constant                       | ms  | Subscribers                                 |
| ------------------------------ | --- | ------------------------------------------- |
| `messageRenderThrottleMs`      | 40  | Visible message renderers                   |
| `messageBookkeepingThrottleMs` | 150 | Scroll handler, composer, automation        |
| `statusOnlyThrottleMs`         | 500 | Subscribers that never read message content |

`status` and `error` use separate unthrottled SDK subscriptions, so transitions
stay instant at any tier. `onFinish` reads the `Chat` instance directly, not a
throttled React snapshot, so persistence is unaffected by these numbers.
`smoothStreamWordDelayMs` (10) must stay at or below the render tier so a fresh
word is ready each paint.

## What must stay in step when you change send behaviour

- A new auto-send path must consult `stopping` (or `stopRequested`), or Stop
  stops working.
- A new request in the send path must draw from the turn budget, or it escapes
  the per-turn spend ceiling.
- A new terminal state must decide explicitly whether `onFinish` persists; the
  partial-save handler's cancel/direct-save branch is written against that
  answer.
- A new error class needs a retry verdict in `onFinish`'s ladder. The default
  (fall through and retry) suits only transient failures.
- Anything read during a send that is not yet on the `chat_threads` row must
  live on `ChatSession`.
- Built-in and ACP diverge on system-channel content (skills, project context).
  A new injected section needs both paths, or it vanishes when the user switches
  agents.

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

- [ACP agents](./acp-agents.md): the adapter lifecycle behind
  `getOrConnectAdapter` (generations, transports, reconnect).
- [Projects](./projects.md): how a project's instructions reach a send, and why
  ACP agents get the prompt section but not the search tool.
- [Widgets](../features/widgets.md): what the assistant's streamed text can
  render into.
