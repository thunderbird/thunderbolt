# Debug Transcripts

A **debug transcript** is an opt-in, full-fidelity record of one chat thread that
a user sends to the Thunderbolt team: every turn's prompt, system prompts,
assistant output, tool calls, failures and timings, plus a free-text note.

| Property                           | Detail                                                                |
| ---------------------------------- | --------------------------------------------------------------------- |
| **Identified, not anonymous**      | The user id and email are sent on purpose, so the team can reply.     |
| **Never stored where collected**   | A relay forwards to a single intake and keeps nothing.                |
| **Correlated with turn telemetry** | Hung off the same instrumentation points, keyed by the same trace id. |

Ordinary telemetry (`chat_turn_completed`) records phase durations, retry counts
and an outcome without content
([`turn-telemetry.ts`](../../src/ai/turn-telemetry.ts),
[chat-runtime.md](./chat-runtime.md#telemetry-and-debug-transcripts)); a
transcript supplies the content behind it. Built-in turns reuse the telemetry
trace id ([`chat-instance.ts`](../../src/chats/chat-instance.ts),
`initializeTurnForCurrentSession`); ACP turns get their own and have no turn
telemetry.

## Roles: relay and intake

One codebase plays both roles, selected by configuration
([`settings.ts:113-117`](../../backend/src/config/settings.ts)). Operator setup,
including how to obtain a client key, is in
[docs/self-hosting/configuration.md](../self-hosting/configuration.md#debug-transcripts).

| Role       | Enabled by                                                        | Mounts                              | Stores   |
| ---------- | ----------------------------------------------------------------- | ----------------------------------- | -------- |
| **Relay**  | `DEBUG_TRANSCRIPT_UPSTREAM_URL` + `DEBUG_TRANSCRIPT_UPSTREAM_KEY` | `POST /v1/debug-transcripts`        | nothing  |
| **Intake** | `DEBUG_TRANSCRIPT_INTAKE_ENABLED=true`                            | `POST /v1/debug-transcripts/intake` | Postgres |

### Relay

- User-authenticated (`guard({ auth: true })`), validated, forwarded with
  `Authorization: Bearer <upstream key>` and a 10-second timeout
  ([`debug-transcripts.ts`](../../backend/src/api/debug-transcripts.ts)).
- `DEBUG_TRANSCRIPT_UPSTREAM_URL` is a base URL: trailing slash stripped,
  `/v1/debug-transcripts/intake` appended. Anything but a `201` with a parseable
  `{ id }` body is a failure.
- Both env vars must be set together or `getSettings()` fails validation.
  `debugTranscriptsEnabled` _derives_ from a non-empty URL
  ([`settings.ts:187-197`](../../backend/src/config/settings.ts)), ships on
  `GET /v1/config` ([`config.ts:23`](../../backend/src/api/config.ts)), and gates
  the Share button
  ([`selectDebugTranscriptsEnabled`](../../src/api/config-store.ts)). No config
  means disabled: standalone has no recipient.
- Persists nothing, so a failed forward leaves no partial state and the app can
  retry. That is why the split exists, not just multi-tenancy.

### Intake

- Deployment-authenticated: the bearer key is SHA-256 hashed and matched against
  `debug_transcript_clients.key_hash`; only the hash is stored
  ([`client-key.ts`](../../backend/src/debug-transcripts/client-key.ts)).
- Unknown key → 401; `revoked_at` set → 403. Clients are revoked, never deleted,
  so their transcripts keep a valid `client_id` (`onDelete: 'restrict'`).
- At startup it upserts a `self` client row from its own upstream key, making the
  deployment a client of itself instead of a handler special case
  ([`ensureSelfDebugTranscriptClient`](../../backend/src/api/debug-transcripts-intake.ts),
  from [`index.ts:63`](../../backend/src/index.ts)).
- Storage:
  [`debug-transcript-schema.ts`](../../backend/src/db/debug-transcript-schema.ts),
  `backend/drizzle/0030_debug_transcripts.sql`. `debug_transcripts.user_id` is an
  id in the _relay's_ database, meaningful only with `client_id`.

## What gets captured

Two sources meet at share time in
[`build-payload.ts`](../../src/debug-transcript/build-payload.ts):

| Source                 | Contents                                                                                                                             | Persisted?        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| **Persisted messages** | The thread's `ThunderboltUIMessage[]`, grouped into turns (a user message plus the assistant messages that follow it)                | yes, and it syncs |
| **Session-only notes** | System prompts, failures, retry reasons, outcome, timings, held in memory by [`recorder.ts`](../../src/debug-transcript/recorder.ts) | no                |

[`message-tool-calls.ts`](../../src/debug-transcript/message-tool-calls.ts)
reconstructs tool calls from the AI SDK's persisted parts, classifying unfinished
states (`input-available`, `approval-requested`, …) as `incomplete` rather than
success.

Trace id staples the two together: while capture is on, `createChatInstance`
stamps `metadata.debugTranscript` (trace id, engine, model, agent) onto saved
messages and the recorder keys notes on the same id
([`chat-instance.ts`](../../src/chats/chat-instance.ts)). The metadata syncs; the
notes do not. Matched turns are `source: 'live'`, the rest `'persisted'` (before
a reload, another device, before the config flag hydrated).

### Recorder bounds and failure modes

- **Bounded ring.** `maxTurnsPerThread = 50`, `maxThreads = 10`
  ([`recorder.ts:16-17`](../../src/debug-transcript/recorder.ts)); threads evict
  least-recently-touched, so a feature most users never invoke cannot leak.
- **Fails silent, not invisible.** Every entry point runs inside
  `protectRecorder`: _any_ internal error latches `recorderDisabled` and warns
  once. The latch ships as `capture.recorderDisabled`, so a transcript reports
  its own degradation.
- **Follows the deployment flag** via a config-store subscription
  ([`config-capture.ts`](../../src/debug-transcript/config-capture.ts), registered
  at the bottom of `recorder.ts` so importing the recorder seeds it). Capture off
  discards the notes.
- **Cleared on identity change.** `clearDebugTranscriptRecorder` runs from
  `clearLocalData` ([`identity-memory.ts`](../../src/lib/identity-memory.ts),
  [`cleanup.ts`](../../src/lib/cleanup.ts)): no note survives sign-out, account
  deletion or device revocation.

## Redaction removes secrets, not people

[`sanitizer.ts`](../../src/debug-transcript/sanitizer.ts) walks the whole JSON
tree before upload, and the free-text note separately
([`api.ts`](../../src/debug-transcript/api.ts)).

| Axis                     | Matches                                                                                                                                                                                                           |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Object key**           | Keys that normalize (case-folded, `-_ ` stripped) to something ending in `token`, or containing `apikey`, `authorization`, `cookie`, `secret`, `password`, `passphrase`, `privatekey`, `credential`, `pwd`        |
| **Pattern in free text** | JWTs, `Bearer` headers, `sk-`/`sk-ant-`/`sk-proj-` keys, `ghp_`/`github_pat_`, `glpat-`, `xoxb-`, `AKIA`, `AIza`, `hf_`, `pplx-`, `npm_`, credential-bearing URL query parameters, `scheme://user:pass@` userinfo |

Pagination cursors also end in "token"; redacting them is the deliberate trade.

It does **not** anonymize: emails, names and user-authored content stay intact,
because stripping secrets is a security control and the report is identified by
design. Anonymous sessions send `identity.userId` and `identity.email` as null.

Stored attribution is separate. The submission schema is `.strict()` with no
`userId`, so a client cannot claim one; the relay adds it from the authenticated
session, null when anonymous
([`debug-transcripts.ts`](../../backend/src/api/debug-transcripts.ts),
[`body.ts`](../../backend/src/debug-transcripts/body.ts)). The payload's
`identity` block is client-supplied; `debug_transcripts.user_id` is not.

## Size: three limits, in order

| Limit                                     | Value        | Where                                                                                    |
| ----------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `maxToolValueSerializedLength`            | 51,200 chars | per tool argument/result, replaced with `[value too large]` (`message-tool-calls.ts:10`) |
| `debugTranscriptClientPayloadTargetBytes` | 1,500,000 B  | client trims oldest turns until under it (`build-payload.ts`)                            |
| `debugTranscriptServerPayloadMaxBytes`    | 2 MiB        | rejected with 413 by both relay and intake                                               |

- The client target sits below the server ceiling so a payload that passed
  locally is not rejected after the round trip.
- `boundPayload` drops the _oldest_ turns (the reported problem is almost always
  the newest) and stops at one, so a single oversized turn earns an honest 413
  instead of being silently emptied.
- `debugTranscriptMaxRequestBytes` = ceiling + 4 KB of metadata. Both routes use
  `parse: 'none'` and stream through `readBoundedJson`, counting bytes
  ([`body.ts`](../../backend/src/debug-transcripts/body.ts)), so a chunked upload
  with no `content-length` cannot outgrow the cap.
- Target, ceiling and request cap live in
  [`shared/debug-transcript-contract.ts`](../../shared/debug-transcript-contract.ts)
  so client and server cannot drift; `maxToolValueSerializedLength` is
  client-only and stays beside the code applying it.

## The wire contract

```json
{
  "schemaVersion": 1,
  "capture": { "capturedAt": "…", "appVersion": "…", "platform": "…", "recorderDisabled": false },
  "identity": { "userId": "…", "email": "…" },
  "thread": { "threadId": "…" },
  "turns": []
}
```

- `identity.userId` and `identity.email` are nullable.
- `turns` holds `DebugTranscriptTurnV1` objects in thread order
  ([`types.ts`](../../src/debug-transcript/types.ts)), each carrying `traceId`,
  `source`, `engine` (`pi` | `legacy` | `acp`), model, message ids, `userPrompt`,
  `systemPrompts` (tagged with the attempt they belonged to), `assistantOutput`,
  `toolCalls`, `failures`, timings and `outcome`.
- Timestamps pair wall clock with a monotonic offset from turn start
  (`performance.now()`), so intra-turn durations survive a clock adjustment. Only
  the recorder produces them, so `userPrompt` and `assistantOutput` (both from
  persisted messages) are null-timestamped even on a `live` turn.

**The server does not know this shape.** Both routes validate only the envelope
(`threadId` pattern, `schemaVersion` integer 1-1000, `userNote` ≤ 2000 chars,
`clientVersion` ≤ 100 chars;
[`body.ts`](../../backend/src/debug-transcripts/body.ts)) and store `payload` as
opaque `jsonb`
([`debug-transcript-schema.ts`](../../backend/src/db/debug-transcript-schema.ts)),
so relays on any app build forward identically and evolving the payload needs no
backend deploy.

### Adding a field to the payload

1. Extend `src/debug-transcript/types.ts` and populate the field in
   `build-payload.ts`, or in the recorder if it is session state.
2. Check the sanitizer covers it. Keys match by name, so a credential-bearing
   field needs a name the key list catches, or a new fragment in
   `sensitiveKeyFragments`.
3. Cap anything unbounded (tool output, a captured request body) in the spirit of
   `boundToolValue`, not just via the payload trimmer.
4. Bump `schemaVersion` only for a breaking shape change. It is stored per row so
   analysis can branch on it; no server change either way.

## Errors and rate limits

Codes live in `shared/debug-transcript-contract.ts` and map to user copy in
[`use-share-debug-transcript-state.ts`](../../src/components/share-debug-transcript/use-share-debug-transcript-state.ts).

| Status  | Code                               | Cause                                                         |
| ------- | ---------------------------------- | ------------------------------------------------------------- |
| 403     | `DEBUG_TRANSCRIPTS_DISABLED`       | Relay not configured; the route is mounted only to say so     |
| 413     | `DEBUG_TRANSCRIPT_TOO_LARGE`       | Request over the byte cap, or payload over 2 MiB              |
| 422     | none                               | Malformed JSON or envelope schema failure                     |
| 429     | none                               | Rate limit; the client maps the status, not a code            |
| 502     | `DEBUG_TRANSCRIPT_UPSTREAM_FAILED` | Intake unreachable, non-201, or an unparseable acknowledgment |
| 401/403 | none                               | Intake only: unknown or revoked client key                    |

Rate limits are hardcoded per tier
([`rate-limit.ts:38-39`](../../backend/src/middleware/rate-limit.ts)):
`debug-transcript` 10/hour by user; `debug-transcript-intake` 600/hour applied
twice, once by client id and once by IP.

`/v1/debug-transcripts/intake` is in `appVersionExemptPrefixes`
([`app-version.ts:24`](../../backend/src/middleware/app-version.ts)): it is
server-to-server with no `X-App-Version` header. The relay route is not exempt
and sends the header like any `HttpClient` call. See "App version gate" in
[AGENTS.md](../../AGENTS.md).

## The share flow

- **Entry point.** Bug icon on the last message that renders content, shown only
  when the deployment flag is on, a thread exists with at least one visible
  message, and turn status is neither `submitted` nor `streaming`
  ([`chat-messages.tsx`](../../src/components/chat/chat-messages.tsx)).
- **Bundle.** `ShareDebugTranscriptAction` is `React.lazy`, keeping dialog,
  payload builder and upload client out of the entry bundle. The recorder is not:
  `chat-instance.ts` imports it directly to stamp correlation metadata.
- **Consent.** The dialog names who can read the transcript, what it contains and
  that the team retains it; an explicit consent checkbox gates submit.
- **State.** `useShareDebugTranscriptState` owns the flow in one reducer plus a
  `useTransition`, aborting any in-flight upload when the dialog closes. Upload
  timeout 30 s.

## File map

| Concern                           | File                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Session-only notes, bounds, latch | `src/debug-transcript/recorder.ts`                                                  |
| Payload assembly and trimming     | `src/debug-transcript/build-payload.ts`                                             |
| Redaction                         | `src/debug-transcript/sanitizer.ts`                                                 |
| Tool-call reconstruction          | `src/debug-transcript/message-tool-calls.ts`                                        |
| Wire types                        | `src/debug-transcript/types.ts`                                                     |
| Upload client                     | `src/debug-transcript/api.ts`                                                       |
| Share UI                          | `src/components/share-debug-transcript/`                                            |
| Shared codes and size limits      | `shared/debug-transcript-contract.ts`                                               |
| Relay route                       | `backend/src/api/debug-transcripts.ts`                                              |
| Intake route                      | `backend/src/api/debug-transcripts-intake.ts`                                       |
| Envelope schema, bounded reader   | `backend/src/debug-transcripts/body.ts`                                             |
| Client-key hashing                | `backend/src/debug-transcripts/client-key.ts`                                       |
| Storage                           | `backend/src/db/debug-transcript-schema.ts`, `backend/src/dal/debug-transcripts.ts` |
