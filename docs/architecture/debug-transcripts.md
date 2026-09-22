# Debug Transcripts

A **debug transcript** is a full-fidelity record of one chat thread that a user
chooses to send to the Thunderbolt team: every turn's prompt, system prompts,
assistant output, tool calls, failures and timings, plus a free-text note.

It exists because the ordinary telemetry path cannot answer "the agent did the
wrong thing here". `chat_turn_completed` carries phase durations, retry counts
and an outcome, deliberately without content
([`src/ai/turn-telemetry.ts`](../../src/ai/turn-telemetry.ts) — see
[chat-runtime.md](./chat-runtime.md#telemetry-and-debug-transcripts)). Debug
transcripts are the opt-in counterpart hung off the same instrumentation points
and correlated by the same trace id, so one report contains both the aggregate
shape of the turn and the content that produced it. For a built-in turn the two
share one id, because the transcript reuses the telemetry trace
([`src/chats/chat-instance.ts`](../../src/chats/chat-instance.ts) —
`initializeTurnForCurrentSession`); an ACP turn gets its own trace id and no
turn telemetry, so the transcript is all there is.

Two consequences follow from that and drive the rest of this document:
transcripts are **identified, not anonymous** (the user id and email are sent
on purpose, so the team can reply), and they are **never stored by the
deployment that collects them** — a relay forwards them to a single intake and
keeps nothing.

## Roles: relay and intake

The same codebase plays two roles, selected by configuration
([`backend/src/config/settings.ts:113-117`](../../backend/src/config/settings.ts)).

| Role       | Enabled by                                                        | Mounts                              | Stores   |
| ---------- | ----------------------------------------------------------------- | ----------------------------------- | -------- |
| **Relay**  | `DEBUG_TRANSCRIPT_UPSTREAM_URL` + `DEBUG_TRANSCRIPT_UPSTREAM_KEY` | `POST /v1/debug-transcripts`        | nothing  |
| **Intake** | `DEBUG_TRANSCRIPT_INTAKE_ENABLED=true`                            | `POST /v1/debug-transcripts/intake` | Postgres |

The two env vars for the relay must be set together or `getSettings()` fails
validation; `debugTranscriptsEnabled` is then _derived_ from the URL being
non-empty ([`settings.ts:187-197`](../../backend/src/config/settings.ts)) and
published on `GET /v1/config`
([`backend/src/api/config.ts:23`](../../backend/src/api/config.ts)). The client
reads that flag to decide whether to render the Share button at all
([`selectDebugTranscriptsEnabled`](../../src/api/config-store.ts)); absent
config means disabled, because standalone mode has no recipient.

The relay authenticates the _user_ (`guard({ auth: true })`), validates, then
forwards with `Authorization: Bearer <upstream key>` and a 10-second timeout
([`backend/src/api/debug-transcripts.ts`](../../backend/src/api/debug-transcripts.ts)).
`DEBUG_TRANSCRIPT_UPSTREAM_URL` is a base URL: the relay strips a trailing slash
and appends `/v1/debug-transcripts/intake`, and treats anything but a `201` with
a parseable `{ id }` body as a failure.

Because the relay persists nothing, a failed forward leaves no partial state and
the app can retry — that is the reason for the split, not just multi-tenancy.

The intake authenticates the _deployment_. The bearer key is SHA-256 hashed and
matched against `debug_transcript_clients.key_hash`; only the hash is ever
stored ([`backend/src/debug-transcripts/client-key.ts`](../../backend/src/debug-transcripts/client-key.ts)).
An unknown key is a 401, a row with `revoked_at` set is a 403 — clients are
revoked, never deleted, so the transcripts they submitted keep a valid
`client_id` (the foreign key is `onDelete: 'restrict'`). At startup the intake
host upserts a `self` client row from its own upstream key, so the Thunderbolt
deployment is a client of itself rather than a special case in the handler
([`ensureSelfDebugTranscriptClient`](../../backend/src/api/debug-transcripts-intake.ts),
called from [`backend/src/index.ts:63`](../../backend/src/index.ts)).

Schema and migration: [`backend/src/db/debug-transcript-schema.ts`](../../backend/src/db/debug-transcript-schema.ts),
`backend/drizzle/0030_debug_transcripts.sql`. `debug_transcripts.user_id` is an
id in the _relay's_ database, not the intake's — it is only meaningful together
with `client_id`.

Operator-facing configuration, including how to obtain a client key, is in
[docs/self-hosting/configuration.md](../self-hosting/configuration.md#debug-transcripts).

## What gets captured

A payload is assembled at share time from two sources that meet in
[`build-payload.ts`](../../src/debug-transcript/build-payload.ts):

- **Persisted messages** — the thread's `ThunderboltUIMessage[]`, grouped into
  turns (a user message plus the assistant messages that follow it). Tool calls
  are reconstructed from the AI SDK's persisted parts by
  [`message-tool-calls.ts`](../../src/debug-transcript/message-tool-calls.ts),
  which classifies unfinished states (`input-available`, `approval-requested`, …)
  as `incomplete` rather than letting them read as successes.
- **Session-only notes** — system prompts, failures, retry reasons, outcome and
  timings, held in memory by
  [`recorder.ts`](../../src/debug-transcript/recorder.ts).

The two are stapled together by trace id. `createChatInstance` stamps
`metadata.debugTranscript` (trace id, engine, model, agent) onto saved messages
while capture is enabled, and the recorder keys its notes on the same id
([`src/chats/chat-instance.ts`](../../src/chats/chat-instance.ts)). The metadata
is persisted with the message and therefore syncs; the notes are not. A turn
that matches notes is marked `source: 'live'`, one that does not is
`'persisted'` — which is what you see for turns from before a reload, from
another device, or from before the config flag hydrated.

### The recorder's bounds

The recorder is a bounded ring: `maxTurnsPerThread = 50` and `maxThreads = 10`
([`recorder.ts:16-17`](../../src/debug-transcript/recorder.ts)), with threads
evicted least-recently-touched. It holds session memory for a feature most
users never invoke, so growing without limit would be a memory leak in the
common case.

Every recording entry point runs inside `protectRecorder`, which latches `recorderDisabled`
on _any_ internal error and warns once. Diagnostics must never break a chat, so
the recorder fails silent — but not invisibly: the latch is copied into
`capture.recorderDisabled` on the payload, so a transcript tells you whether its
own notes were degraded.

Capture follows the deployment flag through a config-store subscription
([`config-capture.ts`](../../src/debug-transcript/config-capture.ts), registered
at the bottom of `recorder.ts` so importing the recorder seeds it). Turning
capture off discards the notes, and `clearDebugTranscriptRecorder` is called
from `clearLocalData` ([`src/lib/identity-memory.ts`](../../src/lib/identity-memory.ts),
[`src/lib/cleanup.ts`](../../src/lib/cleanup.ts)) so no note survives sign-out,
account deletion or device revocation into the next identity.

## Redaction removes secrets, not people

[`sanitizer.ts`](../../src/debug-transcript/sanitizer.ts) walks the whole JSON
tree before upload and, separately, the user's free-text note
([`api.ts`](../../src/debug-transcript/api.ts)). It redacts on two axes:

- **By key** — any object key that normalizes (case-folded, `-_ ` stripped) to
  something ending in `token`, or containing `apikey`, `authorization`,
  `cookie`, `secret`, `password`, `passphrase`, `privatekey`, `credential` or
  `pwd`. Pagination cursors also end in "token"; redacting them is the
  deliberate trade.
- **By pattern in free text** — JWTs, `Bearer` headers, `sk-`/`sk-ant-`/`sk-proj-`
  keys, a battery of known provider formats (`ghp_`/`github_pat_`, `glpat-`,
  `xoxb-`, `AKIA`, `AIza`, `hf_`, `pplx-`, `npm_`), credential-bearing URL query
  parameters, and `scheme://user:pass@` userinfo.

It does **not** anonymize. Emails, names and ordinary user-authored content stay
intact, because the transcript is an identified bug report and stripping secrets
is a security control, not a privacy one. The only identity that _is_ dropped is
an anonymous session's: the client sends `identity.userId` and `identity.email`
as null for anonymous users.

The stored attribution is a separate field. The submission schema is `.strict()`
and has no `userId`, so a client cannot claim one; the relay adds it from the
authenticated session when it forwards, null for an anonymous user
([`debug-transcripts.ts`](../../backend/src/api/debug-transcripts.ts),
[`body.ts`](../../backend/src/debug-transcripts/body.ts)). The payload's
`identity` block is client-supplied; `debug_transcripts.user_id` is not.

## Size: three limits, in order

| Limit                                     | Value        | Where                                                                                    |
| ----------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `maxToolValueSerializedLength`            | 51,200 chars | per tool argument/result, replaced with `[value too large]` (`message-tool-calls.ts:10`) |
| `debugTranscriptClientPayloadTargetBytes` | 1,500,000 B  | client trims oldest turns until under it (`build-payload.ts`)                            |
| `debugTranscriptServerPayloadMaxBytes`    | 2 MiB        | rejected with 413 by both relay and intake                                               |

The client target sits below the server ceiling on purpose: trimming leaves
headroom so a payload that passed locally is not rejected after a round trip.
`boundPayload` shifts the _oldest_ turns off — the reported problem is almost
always the most recent turn — and stops at one turn, so a single oversized turn
still reaches the server and earns an honest 413 rather than being silently
emptied.

The request cap is `debugTranscriptMaxRequestBytes` = payload ceiling + 4 KB for
the metadata around it. Both routes use `parse: 'none'` and read the body
through `readBoundedJson`, which counts bytes as it streams
([`backend/src/debug-transcripts/body.ts`](../../backend/src/debug-transcripts/body.ts)) —
a chunked upload with no `content-length` cannot make the server buffer more
than the cap. The client target, the server ceiling and the request cap all live
in [`shared/debug-transcript-contract.ts`](../../shared/debug-transcript-contract.ts)
so client and server cannot drift; `maxToolValueSerializedLength` is purely
client-side and stays next to the code that applies it.

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

`identity.userId` and `identity.email` are nullable; `turns` holds
`DebugTranscriptTurnV1` objects in thread order. The types are in
[`src/debug-transcript/types.ts`](../../src/debug-transcript/types.ts);
each turn carries `traceId`, `source`, `engine` (`pi` | `legacy` | `acp`),
model, message ids, `userPrompt`, `systemPrompts` (tagged with the attempt they
belonged to), `assistantOutput`, `toolCalls`, `failures`, timings and `outcome`.
Timestamps are a pair: wall clock plus a monotonic offset from the start of the
turn, taken from `performance.now()`, so intra-turn durations survive a
wall-clock adjustment. Only the recorder produces them, so `userPrompt` and
`assistantOutput` — both reconstructed from persisted messages — carry a null
timestamp even on a `live` turn.

**The server does not know this shape.** Both routes validate only the envelope
(`threadId` pattern, `schemaVersion` as an integer 1–1000, `userNote` ≤ 2000
chars, `clientVersion` ≤ 100 chars —
[`body.ts`](../../backend/src/debug-transcripts/body.ts)) and treat `payload` as
opaque JSON, stored in a `jsonb` column
([`debug-transcript-schema.ts`](../../backend/src/db/debug-transcript-schema.ts)).
That is intentional: relays running older or newer app builds all forward the
same way, and evolving the payload needs no backend deploy.

### Adding a field to the payload

1. Extend the types in `src/debug-transcript/types.ts` and populate the field in
   `build-payload.ts` (or in the recorder, if it is session state).
2. Check the sanitizer covers it. Object keys are matched by name, so a field
   holding credentials needs a name the key list already catches — or a new
   fragment in `sensitiveKeyFragments`.
3. Account for size. Anything unbounded (tool output, a captured request body)
   needs its own cap in the spirit of `boundToolValue`, not just the payload
   trimmer.
4. Bump `schemaVersion` only for a breaking change to the shape. The value is
   stored per row so analysis can branch on it; no server change is required
   either way.

## Errors and rate limits

Codes are shared in `shared/debug-transcript-contract.ts` and mapped to user
copy in [`use-share-debug-transcript-state.ts`](../../src/components/share-debug-transcript/use-share-debug-transcript-state.ts).

| Status  | Code                               | Cause                                                         |
| ------- | ---------------------------------- | ------------------------------------------------------------- |
| 403     | `DEBUG_TRANSCRIPTS_DISABLED`       | Relay not configured; the route is mounted only to say so     |
| 413     | `DEBUG_TRANSCRIPT_TOO_LARGE`       | Request over the byte cap, or payload over 2 MiB              |
| 422     | —                                  | Malformed JSON or envelope schema failure                     |
| 429     | —                                  | Rate limit; the client maps the status, not a code            |
| 502     | `DEBUG_TRANSCRIPT_UPSTREAM_FAILED` | Intake unreachable, non-201, or an unparseable acknowledgment |
| 401/403 | —                                  | Intake only: unknown or revoked client key                    |

Rate limits are hardcoded per tier in
[`backend/src/middleware/rate-limit.ts:38-39`](../../backend/src/middleware/rate-limit.ts):
`debug-transcript` is 10 per hour keyed by user, `debug-transcript-intake` is
600 per hour applied twice — once keyed by client id, once by IP.

`/v1/debug-transcripts/intake` is listed in `appVersionExemptPrefixes`
([`backend/src/middleware/app-version.ts:24`](../../backend/src/middleware/app-version.ts))
because it is a server-to-server call with no `X-App-Version` header; the
user-facing relay route is not exempt and sends the header like any other
`HttpClient` call. See "App version gate" in [AGENTS.md](../../AGENTS.md).

## The share flow

The Share button is a bug icon on the last message that renders content, shown
only when the deployment flag is on, a thread exists, it has at least one
visible message, and the turn status is neither `submitted` nor `streaming`
([`src/components/chat/chat-messages.tsx`](../../src/components/chat/chat-messages.tsx)).
`ShareDebugTranscriptAction` is loaded with `React.lazy`, so the dialog, the
payload builder and the upload client stay out of the entry bundle — the
recorder itself does not, because `chat-instance.ts` imports it directly to
stamp correlation metadata. The dialog states in plain copy who can
read the transcript, what it contains, and that the Thunderbolt team retains it,
and requires an explicit consent checkbox before the submit button does
anything.

`useShareDebugTranscriptState` owns the whole flow in one reducer plus a
`useTransition`, and aborts any in-flight upload when the dialog closes. Upload
timeout is 30 s.

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
