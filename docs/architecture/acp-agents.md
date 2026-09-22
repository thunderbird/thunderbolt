# ACP Agents

Thunderbolt can hand a chat thread to an external coding agent instead of running the built-in
AI-SDK pipeline. The wire is the [Agent Client Protocol](https://agentclientprotocol.com) (ACP), a
JSON-RPC protocol over a bidirectional byte stream. This document covers the client library in
[`src/acp/`](../../src/acp), the transports it can open, the iroh trust model, and the backend's
discovery and managed-agent routes.

The CLI side — the `thunderbolt acp serve` agent, its workspace jail, its toolset, and the `wss`
bridge's Origin/token gate — is documented in [cli/README.md](../../cli/README.md). Relay operation
for the peer-to-peer transport is in [iroh-relay-self-hosting.md](./iroh-relay-self-hosting.md).

## Three kinds of agent, three places rows live

`AgentType` ([shared/acp-types.ts](../../shared/acp-types.ts)) has three members, and each is stored
differently. The split matters: it decides what syncs between devices, what survives sign-out, and
what a server operator controls.

| Type          | What it is                                                     | Where the row lives                                                                                      |
| ------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `built-in`    | The in-process Thunderbolt assistant. No ACP wire is involved. | Nowhere — a hardcoded constant, `builtInAgent` in [src/defaults/agents.ts](../../src/defaults/agents.ts) |
| `remote-acp`  | An agent the user added in Settings → Agents                   | Synced `agents` table; credentials in the local-only `agents_secrets`                                    |
| `managed-acp` | An agent the backend itself serves (today: Haystack/Deepset)   | Local-only `agents_system`, re-hydrated from `GET /v1/agents` on every bootstrap                         |

The local-only tables are registered in
[src/db/powersync/schema.ts](../../src/db/powersync/schema.ts) under `localOnlyTables` and therefore
never leave the device. That is deliberate for `agents_secrets` (API keys) and structural for
`agents_system` (the backend is the source of truth, so syncing a cached copy would only create
conflicts). The synced `agents` table is **not** in `encryptedColumnsMap` — see the note in
[e2e-encryption.md](./e2e-encryption.md).

`refreshSystemAgents` ([src/db/seeding/seed-agents.ts](../../src/db/seeding/seed-agents.ts)) does the
hydration and is careful about failure modes: a 200 upserts and prunes, a 401/403 clears the table
(the caller cannot see system agents), and anything else — network, 5xx, parse error — leaves the
existing rows alone so an offline user keeps the list they had. When a refresh changes a system
agent's `url` or `transport`, it clears that agent's stored ACP session ids and asks the adapter
cache to drop the warm connection: the session ids were minted by the old endpoint and mean nothing
to the new one.

## One adapter per agent, many threads

The chat layer calls `connectToAgent` ([src/acp/connect.ts](../../src/acp/connect.ts)) and gets back
an `AgentAdapter` whose `fetch(init, ctx)` returns a streaming `Response` in AI-SDK shape. A
`built-in` agent short-circuits to `createBuiltInAdapter`; everything else goes through
`connectAcpAdapter` ([src/acp/acp-adapter.ts](../../src/acp/acp-adapter.ts)).

**One adapter owns one transport, one `ClientSideConnection`, and one `initialize`, and multiplexes
many per-thread ACP sessions over it.** Per-thread state — the ACP session id, the permission
callback, the side-effect sink — travels on each `fetch` call rather than on connect, which is what
lets every thread targeting the same agent share a single socket. `session/update` notifications are
routed back to the owning thread by their `sessionId`, so two threads streaming at once cannot bleed
into each other. Each thread's session id is persisted on `chat_threads.acp_session_id`
([src/db/tables.ts](../../src/db/tables.ts)) and resolved lazily on first send: with a stored id the
adapter tries `session/resume`, then `session/load`, each degrading to the next; otherwise it mints
`session/new`. For an agent that advertises neither `resume` nor `loadSession`, that first send also
seeds the prior transcript as context so the fresh session is not blind.

The `initialize` handshake is raced against both the transport's terminal-close signal and a 30s
budget. The budget is generous because a cold-starting upstream container can be slow to answer, and
it bounds only the handshake — the prompt/streaming phase is legitimately long and is torn down via
the transport instead.

### The generation invariant

[`AdapterSlot`](../../src/acp/adapter-slot.ts) owns one replaceable adapter _generation_ and fences
every async transition on a monotonic counter. The rule it exists to enforce:

> A terminated connection is rebuilt as a complete generation — transport, `ClientSideConnection`,
> `initialize`, and session attachment together — never by swapping a fresh transport underneath
> live JSON-RPC state.

Half-swapping would leave request ids, session ids and pending promises from the dead connection
pointing at a peer that has never heard of them. The slot's `generation` check is why a `connect()`
that resolves after a newer rebuild started disconnects itself and throws rather than installing
itself.

[`adapter-cache.ts`](../../src/acp/adapter-cache.ts) holds one slot per agent id and wires the
consequences of a termination: clear the agent's advertised commands, cancel its pending permission
prompts, and register a background rebuild with the reconnect scheduler — unless the termination
carries `retryable: false`, in which case redialing the same endpoint cannot succeed and no rebuild
is scheduled. `disposeAdapter` / `disposeAllAdapters` are the real teardown path (agent deleted,
config edited, sign-out); `clearLocalData` calls the latter before anything else so no agent
transport survives an identity change (see
[delete-account-and-revoke-device.md](./delete-account-and-revoke-device.md)).

### Retry budget and terminal close codes

[`reconnect-scheduler.ts`](../../src/acp/reconnect-scheduler.ts) schedules bounded, coalesced
rebuilds: exponential backoff from 1s to 30s, at most 6 attempts, at most 2 concurrent rebuilds, and
— importantly — a connection must stay up for 30s before the attempt budget resets. The CLI bridge
spawns one agent subprocess per accepted connection, so a bridge that accepts and dies moments later
must keep draining the budget instead of earning a fresh immediate redial on every crash-loop cycle.

[`websocket.ts`](../../src/acp/transports/websocket.ts) classifies close codes `1000`, `1011`, `4001`,
`4002` and `4003` as terminal. A remote `1000` counts because it is the bridge deliberately shutting
down, and auto-reconnecting would resurrect a doomed subprocess on a dead endpoint. The verdict
travels as a typed [`TransportTerminationError`](../../src/acp/termination.ts) for lifecycle code and,
because connect rejections reach the chat layer as a bare string, also as JSON inside the message.

### Translation and commands

[`translators/acp-to-ai-sdk.ts`](../../src/acp/translators/acp-to-ai-sdk.ts) converts ACP
`session/update` notifications into the AI-SDK v5 UI message stream (`data: <json>\n\n` chunks) that
`DefaultChatTransport` already consumes, coalescing text deltas on a 200 ms flush. This is the only
seam where ACP vocabulary becomes app vocabulary; the rest of the chat UI does not know ACP exists.

`available_commands_update` is the exception — it is captured at the adapter's session router rather
than in a prompt's stream, because commands are an _agent-level_ capability shared by all of that
agent's threads. They land in [`agent-commands-store.ts`](../../src/acp/agent-commands-store.ts),
keyed by agent id, and surface in the chat input's slash menu. Termination and disposal both clear
them so the menu never offers a command from a disconnected agent.

Remote and managed agents receive project instructions folded into the prompt text, but no project
tool — ACP has no system channel. The rationale is in [projects.md](./projects.md).

## Transport routing

`openTransport` ([src/acp/transports/index.ts](../../src/acp/transports/index.ts)) picks a socket
from the agent type and the runtime. Three rules, in order:

1. **`transport: 'iroh'`** dials a peer bridge by NodeId or ticket; no URL, proxy, or bearer routing
   applies.
2. **`managed-acp`** always connects natively to the URL. Whenever an authenticated `httpClient` is
   wired it attaches the auth token as a `thunderbolt.bearer.<token>` entry in
   `Sec-WebSocket-Protocol` alongside the `thunderbolt.v1` carrier
   ([shared/ws-bearer.ts](../../shared/ws-bearer.ts)); with no client wired (true Standalone, no
   backend reachable) it falls back to a direct unauthenticated connect. The endpoint is the cloud
   backend itself, so the universal-proxy toggle — which governs _external_ traffic — is orthogonal.
   Tunnelling it through `/v1/proxy/ws` would break auth outright: the relay strips every
   `thunderbolt.*` subprotocol entry before dialling upstream (the namespace is server-side
   plumbing and must not leak to an upstream handshake), so the credential would never arrive. The
   bearer rides a subprotocol because browsers cannot set `Authorization` on `new WebSocket()`, and
   unlike the URL it is not logged by default.
3. **`remote-acp`** uses `isStandaloneTransport` — Tauri **and** the proxy toggle off — to choose a
   native `new WebSocket()`. Everything else is relayed through `createProxyWebSocket`
   ([src/lib/proxy-fetch.ts](../../src/lib/proxy-fetch.ts)), which targets `${cloudUrl}/proxy/ws`.

### The relay will not carry a loopback bridge

This is the failure that surprises people. `validateWsTarget`
([backend/src/proxy/ws.ts](../../backend/src/proxy/ws.ts)) rejects any target that is not `wss:`, plus
`localhost`, `*.localhost`, and any private address, and the upgrade handler turns both verdicts into
a bare HTTP 400. The `wss` CLI bridge, meanwhile, binds `127.0.0.1` and prints
`ws://127.0.0.1:<port>/?token=…` as the URL to paste into the app. Both are correct in isolation: the
relay is an SSRF control on a server that would otherwise dial anything, and the bridge is loopback
because it spawns agent subprocesses.

The consequence is that a loopback bridge URL works on Tauri with the proxy off and fails on web. The
add-agent form accepts `ws://` by design (LAN and dev endpoints have no TLS; only Tauri iOS rejects
it, because ATS blocks cleartext — see
[validate-agent-url.ts](../../src/components/settings/agents/validate-agent-url.ts)), so nothing warns
you at save time.

The form's "Test connection" button — offered for WebSocket endpoints only; an iroh target is
verified on first chat — does not warn you either.
[`connection-test.ts`](../../src/acp/connection-test.ts) calls `openWebSocketTransport` directly and
deliberately skips `openTransport`'s routing, because a custom agent carries its own auth and the
probe never needs a backend credential. A native socket is therefore what the probe opens, whichever
runtime you are in — a green probe is evidence about the endpoint, not about the path the saved agent
will take on web. For anything other than that native path — the web app, or Tauri with the proxy on
— use `--transport iroh` instead of the loopback `wss` bridge.

## iroh: identity, pairing, and trust

The iroh transport ([src/acp/iroh/iroh-transport.ts](../../src/acp/iroh/iroh-transport.ts)) dials a
`thunderbolt acp --transport iroh` bridge over a relay, end to end encrypted to the bridge's NodeId.
The dial runs in a Rust→wasm client (`crates/thunderbolt-acp-client`) because iroh has no browser TS
SDK; the chunk is lazy-loaded on first use and one relay endpoint is shared across every iroh agent,
each opening its own bidirectional stream. The stream is a raw byte pipe, so the transport adds ndjson
framing to carry ACP JSON-RPC objects.

**The ALPN must match byte for byte.** Both ends derive it from `irohAlpnFor`
([shared/iroh.ts](../../shared/iroh.ts)) as `thunderbolt/<protocol>/0`, so an ACP client cannot drive
an MCP bridge — the QUIC handshake is refused. The CLI reinforces this at the identity layer:
[cli/src/iroh/paths.ts](../../cli/src/iroh/paths.ts) gives each protocol its own secret key file under
`~/.thunderbolt/iroh/` (`identity` for ACP, `identity-<protocol>` otherwise, the legacy filename kept
so existing ACP pairings survive), so the two bridges have different NodeIds and a stale address
cannot resolve the wrong process.

### Two trust layers

A bridge admits a peer if its handshake-authenticated NodeId is in **either** of two places
([cli/src/iroh/bridge.ts](../../cli/src/iroh/bridge.ts), `isConnectionAllowed`):

- **The account allowlist** — the trusted, non-revoked NodeIds of the account the CLI is logged in to.
  The bridge fetches it from `GET /v1/devices/allowlist` with its stored credential, caches it in
  memory, and refreshes it on a 45s heartbeat. Checked first, and short-circuits.
- **The manual `iroh allow` file** — a newline-delimited NodeId list. This layer stays mandatory for
  Standalone (no account), cross-account, and CI use; when the CLI has no credential the account layer
  is simply absent and the bridge falls back without erroring.

The app does not ask the user to run `thunderbolt iroh allow` for their own machines.
`ensureSelfEnrollment` ([src/lib/iroh-enrollment.ts](../../src/lib/iroh-enrollment.ts)) posts this
app's own dialer NodeId to `POST /v1/devices/me/node-id`, which pins the write to the session's bound
device — so a session can only ever declare its _own_ NodeId, and declaring one you cannot dial as
grants nothing (proof of possession happens at the QUIC handshake). Enrollment is best-effort by
construction: the iroh transport awaits it before dialling, but `ensureSelfEnrollment` warns and
resolves rather than rejecting, and the add-agent panel posts the same NodeId through
`fireAndForgetSelfEnrollment` so a failure never blocks the add — the form's manual pairing command
stays the fallback. The bridge registers itself symmetrically via `POST /v1/devices/bridge`, creating a
`device_type = 'bridge'` row named after the host — subject to the per-account device cap (422) and
refusing to silently resurrect a revoked identity (409, surfaced as `BridgeDeviceRevokedError` telling
the user to remove it in Settings → Devices). See
[powersync-account-devices.md](./powersync-account-devices.md) for the device lifecycle.

Revocation is therefore mid-session, not just at connect. Each heartbeat re-checks every open
connection against the refreshed allowlist and closes the ones that are no longer allowed. If the
refresh no longer lists the bridge's _own_ NodeId, the account has revoked this device: account
auto-trust switches off entirely and every same-account session is torn down, while manual-file peers
survive because manual trust is independent.

Before any of that, the bridge spends a pre-handshake budget on each remote: 10 connections per 10s
sliding window, plus a global cap of 16 concurrent TLS handshakes. The per-remote budget is defeated
by an attacker minting a fresh identity per connection; the global cap is the CPU backstop that holds
regardless of identity. A separate ceiling of 16 concurrent agent subprocesses
([cli/src/commands/bridge.ts](../../cli/src/commands/bridge.ts)) bounds what an admitted peer can spawn.

### The client secret is plaintext in localStorage

The app's iroh secret key is persisted at `iroh_acp_client_secret` in `localStorage` so the NodeId
stays stable and a bridge operator allowlists the app once. That secret _is_ the bridge access
credential, and it is currently XSS-exfiltratable and outlives any patched XSS — the source file says
so, with a TODO to move it behind the encryption middleware. `clearIrohClientSecret` is the wipe path,
called from `clearLocalData` on sign-out, account deletion and device revocation; it also bumps a
generation counter so a bind still in flight cannot re-persist the secret that was just cleared.

## Backend: discovery and managed agents

### `GET /v1/agents`

[backend/src/agents/routes.ts](../../backend/src/agents/routes.ts) answers with
`{ version: '1', agents, allowCustomAgents }`. Unauthenticated callers get 401; anonymous sessions get
403 `ANONYMOUS_DISCOVERY_FORBIDDEN` and fall back to the built-in agent only. `version` exists so the
shape can evolve; `allowCustomAgents` mirrors the `ALLOW_CUSTOM_AGENTS` env so a deployment can hide
"+ Add Custom Agent" without a client build.

The list comes from a module-level provider registry
([backend/src/agents/discovery.ts](../../backend/src/agents/discovery.ts)). Registration is
side-effectful by design — `createHaystackRoutes()` registers its provider as part of construction —
and idempotent on `id`, so HMR and repeated test setup cannot double-register. A provider whose
`list()` throws is logged and skipped rather than failing the response for the others. Descriptor URLs
are built by `buildWebSocketUrl`, which derives scheme and host from `x-forwarded-proto` /
`x-forwarded-host` so dev (`ws://localhost:8000`) and production behind a TLS proxy
(`wss://host/v1/...`) both come out right with no env pinning.

Three settings ([backend/src/config/settings.ts](../../backend/src/config/settings.ts)) control
visibility:

| Env                      | Effect                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLED_AGENTS`         | Comma-separated descriptor ids to expose. Empty means all registered.                                                             |
| `ALLOW_CUSTOM_AGENTS`    | Echoed into both the discovery response and `GET /v1/config`; the UI hides the add-agent affordance when false.                   |
| `DISABLE_BUILT_IN_AGENT` | Surfaced **inverted** on `GET /v1/config` as `builtInAgentEnabled`; the client then omits the built-in agent from its agent list. |

### Haystack / Deepset

[backend/src/haystack/](../../backend/src/haystack) is the one managed-agent provider today. Each entry
in `HAYSTACK_PIPELINES` — a JSON array — becomes a `managed-acp` descriptor pointing at
`/v1/haystack/ws?pipeline=<id>`:

```json
[
  {
    "id": "support",
    "name": "Support Assistant",
    "pipelineName": "support-rag",
    "pipelineId": "3f0c2b4e-...",
    "description": "Answers from the support knowledge base"
  }
]
```

The three id-like fields are not interchangeable: `id` is the public slug that appears in the URL and
in `ENABLED_AGENTS`, `pipelineName` is the Deepset URL slug, and `pipelineId` is the Deepset UUID.

**Parsing is fail-soft.** A missing, empty, malformed-JSON or schema-mismatched value yields zero
descriptors with a WARN log and no error ([provider.ts](../../backend/src/haystack/provider.ts)) —
throwing would cascade into a failed discovery response for unrelated providers. If pipelines do not
appear in the app, check the backend log for `HAYSTACK_PIPELINES is not valid JSON` or
`HAYSTACK_PIPELINES schema mismatch` before looking anywhere else.

`WS /v1/haystack/ws` is the ACP wire. `HaystackAcpServer`
([acp-server.ts](../../backend/src/haystack/acp-server.ts)) implements the agent half of ACP directly
over the socket's text frames and drives the Deepset pipeline over SSE
([sse-parser.ts](../../backend/src/haystack/sse-parser.ts)). Auth is the same bearer subprotocol the
client attaches, validated in `open()` rather than `beforeHandle` — Bun's adapter can invoke
`beforeHandle` more than once per upgrade, while `open()` runs exactly once per accepted socket. The
carrier subprotocol is echoed back so strict clients see their offer accepted; the bearer entry is
deliberately _not_ echoed, keeping it out of `WebSocket.protocol` and proxy response logs.

`GET /v1/haystack/files/:fileId` proxies Deepset file downloads with the server-side workspace key,
streaming the body straight through. File ids are constrained to `^[\w-]+$` before the upstream call,
and an upstream 401/403 is reported as 502: it means a misconfigured server key, and returning it
verbatim would send the client off to re-authenticate for no reason.

## Where the code lives

| Area                        | Path                                                                                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public client surface       | [src/acp/index.ts](../../src/acp/index.ts)                                                                                                                                                                           |
| Adapters                    | [acp-adapter.ts](../../src/acp/acp-adapter.ts), [built-in-adapter.ts](../../src/acp/built-in-adapter.ts)                                                                                                             |
| Connection lifecycle        | [adapter-cache.ts](../../src/acp/adapter-cache.ts), [adapter-slot.ts](../../src/acp/adapter-slot.ts), [reconnect-scheduler.ts](../../src/acp/reconnect-scheduler.ts), [termination.ts](../../src/acp/termination.ts) |
| Transports                  | [src/acp/transports/](../../src/acp/transports), [src/acp/iroh/](../../src/acp/iroh)                                                                                                                                 |
| ACP → AI SDK translation    | [translators/acp-to-ai-sdk.ts](../../src/acp/translators/acp-to-ai-sdk.ts)                                                                                                                                           |
| Data access and seeding     | [src/dal/agents.ts](../../src/dal/agents.ts), [src/db/seeding/seed-agents.ts](../../src/db/seeding/seed-agents.ts)                                                                                                   |
| Settings UI                 | [src/components/settings/agents/](../../src/components/settings/agents)                                                                                                                                              |
| Wire contract               | [shared/acp-types.ts](../../shared/acp-types.ts), [shared/iroh.ts](../../shared/iroh.ts), [shared/ws-bearer.ts](../../shared/ws-bearer.ts)                                                                           |
| Backend discovery           | [backend/src/agents/](../../backend/src/agents)                                                                                                                                                                      |
| Backend managed agent       | [backend/src/haystack/](../../backend/src/haystack)                                                                                                                                                                  |
| WebSocket relay             | [backend/src/proxy/ws.ts](../../backend/src/proxy/ws.ts)                                                                                                                                                             |
| CLI bridge and served agent | [cli/src/iroh/](../../cli/src/iroh), [cli/src/acp/](../../cli/src/acp)                                                                                                                                               |
| wasm iroh client            | `crates/thunderbolt-acp-client` (built artifact committed at `src/acp/iroh/pkg`)                                                                                                                                     |

## Further reading

- [cli/README.md](../../cli/README.md) — the served agent's toolset and workspace jail, the `wss`
  bridge's Origin + token gate and `THUNDERBOLT_APP_ORIGIN`, and the on-disk ACP session logs.
- [iroh-relay-self-hosting.md](./iroh-relay-self-hosting.md) — what a relay does and how to run one.
- [powersync-account-devices.md](./powersync-account-devices.md) — the device table, `bridge` rows,
  and revocation.
- [projects.md](./projects.md) — why ACP agents get project instructions but not the project tool.
- [multi-device-sync.md](./multi-device-sync.md) — which agent tables sync and which are local-only.
