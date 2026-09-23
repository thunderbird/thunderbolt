# ACP Agents

Thunderbolt can hand a chat thread to an external coding agent instead of the built-in AI-SDK
pipeline. The wire is the [Agent Client Protocol](https://agentclientprotocol.com) (ACP): JSON-RPC
over a bidirectional byte stream. Client library: [`src/acp/`](../../../src/acp); the agent the CLI
serves (`thunderbolt acp serve`) is in [cli/README.md](../../../cli/README.md).

## Three kinds of agent, three places rows live

`AgentType` ([shared/acp-types.ts](../../../shared/acp-types.ts)) has three members.

| Type          | What it is                                                     | Where the row lives                                                                                        |
| ------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `built-in`    | The in-process Thunderbolt assistant. No ACP wire is involved. | Nowhere: a hardcoded constant, `builtInAgent` in [src/defaults/agents.ts](../../../src/defaults/agents.ts) |
| `remote-acp`  | An agent the user added in Settings → Agents                   | Synced `agents` table; credentials in the local-only `agents_secrets`                                      |
| `managed-acp` | An agent the backend itself serves (today: Haystack/Deepset)   | Local-only `agents_system`, re-hydrated from `GET /v1/agents` on every bootstrap                           |

- Both local-only tables sit under `localOnlyTables` in
  [src/db/powersync/schema.ts](../../../src/db/powersync/schema.ts) and never leave the device:
  deliberate for `agents_secrets` (API keys), structural for `agents_system` (the backend is source
  of truth, so a synced cache would only create conflicts).
- The synced `agents` table is **not** in `encryptedColumnsMap`
  ([e2e-encryption.md](e2e-encryption.md)).

### How `agents_system` is hydrated

[src/db/seeding/seed-agents.ts](../../../src/db/seeding/seed-agents.ts), `refreshSystemAgents`:

| `GET /v1/agents` returns                  | Effect                                                                |
| ----------------------------------------- | --------------------------------------------------------------------- |
| 200                                       | Upsert and prune                                                      |
| 401 / 403                                 | Clear the table; the caller cannot see system agents                  |
| Anything else (network, 5xx, parse error) | Leave existing rows alone, so an offline user keeps the list they had |

A changed `url` or `transport` also clears that agent's stored ACP session ids and drops the warm
connection from the adapter cache: ids minted by the old endpoint mean nothing to the new one.

## One adapter per agent, many threads

`connectToAgent` ([src/acp/connect.ts](../../../src/acp/connect.ts)) returns an `AgentAdapter` whose
`fetch(init, ctx)` yields a streaming `Response` in AI-SDK shape. `built-in` short-circuits to
`createBuiltInAdapter`, everything else to `connectAcpAdapter`
([src/acp/acp-adapter.ts](../../../src/acp/acp-adapter.ts)).

> One adapter owns one transport, one `ClientSideConnection`, and one `initialize`, and multiplexes
> many per-thread ACP sessions over it.

- **Per-thread state travels on each `fetch`, not on connect**: ACP session id, permission callback,
  side-effect sink. That is what lets every thread on one agent share one socket.
- **`session/update` notifications route by `sessionId`**, so concurrent streams cannot bleed.
- **Session ids persist on `chat_threads.acp_session_id`** ([src/db/tables.ts](../../../src/db/tables.ts))
  and resolve lazily on first send: `session/resume`, degrading to `session/load`, degrading to
  `session/new`.
- **An agent advertising neither `resume` nor `loadSession`** also gets the prior transcript seeded
  as context on the first send, so the fresh session is not blind.
- **`initialize` races the transport's terminal-close signal and a 30s budget.** 30s is generous
  because upstream containers cold-start slowly, and it bounds the handshake only: the
  prompt/streaming phase is legitimately long and is torn down via the transport.

### The generation invariant

[`AdapterSlot`](../../../src/acp/adapter-slot.ts) owns one replaceable adapter _generation_, fencing
every async transition on a monotonic counter:

> A terminated connection is rebuilt as a complete generation (transport, `ClientSideConnection`,
> `initialize`, and session attachment together), never by swapping a fresh transport underneath
> live JSON-RPC state.

Half-swapping would leave request ids, session ids and pending promises pointing at a peer that
never heard of them. A `connect()` resolving after a newer rebuild fails its `generation` check,
disconnects and throws.

[`adapter-cache.ts`](../../../src/acp/adapter-cache.ts) holds one slot per agent id. On termination it:

- clears the agent's advertised commands;
- cancels its pending permission prompts;
- registers a background rebuild with the reconnect scheduler, unless the termination carries
  `retryable: false` (redialing the same endpoint cannot succeed).

`disposeAdapter` / `disposeAllAdapters` are the real teardown path (agent deleted, config edited,
sign-out). `clearLocalData` calls the latter first so no transport survives an identity change
([delete-account-and-revoke-device.md](delete-account-and-revoke-device.md)).

### Retry budget and terminal close codes

[`reconnect-scheduler.ts`](../../../src/acp/reconnect-scheduler.ts) schedules bounded, coalesced
rebuilds:

| Knob                                    | Value                  |
| --------------------------------------- | ---------------------- |
| Backoff                                 | exponential, 1s to 30s |
| Attempts                                | at most 6              |
| Concurrent rebuilds                     | at most 2              |
| Uptime before the attempt budget resets | 30s                    |

The uptime threshold exists because the CLI bridge spawns one subprocess per accepted connection: a
bridge that accepts then dies must keep draining the budget, not earn a fresh redial each cycle.

[`websocket.ts`](../../../src/acp/transports/websocket.ts) treats close codes **`1000`, `1011`, `4001`,
`4002` and `4003`** as terminal. `1000` counts because it is the bridge deliberately shutting down,
and redialling would resurrect a doomed subprocess on a dead endpoint. The verdict travels as a
typed [`TransportTerminationError`](../../../src/acp/termination.ts), and as JSON inside the message,
because connect rejections reach the chat layer as a bare string.

### Translation and commands

- [`translators/acp-to-ai-sdk.ts`](../../../src/acp/translators/acp-to-ai-sdk.ts) converts ACP
  `session/update` notifications into the AI-SDK v5 UI message stream (`data: <json>\n\n` chunks)
  `DefaultChatTransport` already consumes, coalescing text deltas on a 200 ms flush. It is the only
  seam where ACP vocabulary becomes app vocabulary; the chat UI does not know ACP exists.
- `available_commands_update` is captured at the adapter's session router rather than in a prompt's
  stream, because commands are _agent-level_, shared by every thread on that agent. They land in
  [`agent-commands-store.ts`](../../../src/acp/agent-commands-store.ts) keyed by agent id and surface in
  the slash menu; termination and disposal clear them, so no command outlives its connection.
- Remote and managed agents get project instructions folded into the prompt text but no project tool,
  because ACP has no system channel ([projects.md](projects.md)).

## Transport routing

`openTransport` ([src/acp/transports/index.ts](../../../src/acp/transports/index.ts)) picks a socket
from the agent type and the runtime, in order:

| #   | Condition           | Socket                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `transport: 'iroh'` | Dials a peer bridge by NodeId or ticket. No URL, proxy, or bearer routing applies.                                                                                                                                                                                                                                                                                         |
| 2   | `managed-acp`       | Always native to the URL. With an authenticated `httpClient` wired, the auth token rides as a `thunderbolt.bearer.<token>` entry in `Sec-WebSocket-Protocol` alongside the `thunderbolt.v1` carrier ([shared/ws-bearer.ts](../../../shared/ws-bearer.ts)); with no client wired (true Standalone, no backend reachable) it falls back to a direct unauthenticated connect. |
| 3   | `remote-acp`        | `isStandaloneTransport` (Tauri **and** the proxy toggle off) selects a native `new WebSocket()`. Everything else is relayed through `createProxyWebSocket` ([src/lib/proxy-fetch.ts](../../../src/lib/proxy-fetch.ts)), which targets `${cloudUrl}/proxy/ws`.                                                                                                              |

- Rule 2 ignores the universal-proxy toggle: the endpoint is the cloud backend itself, and the
  toggle governs _external_ traffic. Tunnelling through `/v1/proxy/ws` breaks auth, because the
  relay strips every `thunderbolt.*` subprotocol entry before dialling upstream (the namespace is
  server-side plumbing and must not leak to an upstream handshake), so the credential never arrives.
- The bearer rides a subprotocol because browsers cannot set `Authorization` on `new WebSocket()`,
  and unlike the URL it is not logged by default.

### The relay will not carry a loopback bridge

- `validateWsTarget` ([backend/src/proxy/ws.ts](../../../backend/src/proxy/ws.ts)) rejects any target
  that is not `wss:`, plus `localhost`, `*.localhost`, and any private address; the upgrade handler
  turns both verdicts into a bare HTTP 400.
- The `wss` CLI bridge binds `127.0.0.1` and prints `ws://127.0.0.1:<port>/?token=…` as the URL to
  paste into the app.
- **So a loopback bridge URL works on Tauri with the proxy off, and fails on web.**

Both halves are correct: the relay is an SSRF control on a server that would otherwise dial
anything, and the bridge is loopback because it spawns subprocesses. Nothing warns you at save time, and the form accepts `ws://` by design (LAN and dev
endpoints have no TLS; only Tauri iOS rejects it, ATS blocks cleartext, see
[validate-agent-url.ts](../../../src/components/settings/agents/validate-agent-url.ts)).

"Test connection" covers WebSocket endpoints only (iroh is verified on first chat) and does not warn
either. [`connection-test.ts`](../../../src/acp/connection-test.ts) calls `openWebSocketTransport`
directly, skipping `openTransport`'s routing, because a custom agent carries its own auth and never
needs a backend credential. The probe therefore opens a native socket whichever runtime you are in,
so a green probe is evidence about the endpoint, not about the path the saved agent takes on web.

Off that native path (web, or Tauri with the proxy on) use `--transport iroh`.

## iroh: identity, pairing, and trust

The iroh transport ([src/acp/iroh/iroh-transport.ts](../../../src/acp/iroh/iroh-transport.ts)) dials a
`thunderbolt acp --transport iroh` bridge over a relay, encrypted end to end to its NodeId.

- The dial runs in a Rust→wasm client (`crates/thunderbolt-acp-client`, lazy-loaded on first use)
  because iroh has no browser TS SDK.
- One relay endpoint is shared across every iroh agent, each opening its own bidirectional stream.
- The stream is a raw byte pipe, so the transport adds ndjson framing for ACP JSON-RPC objects.
- **The ALPN must match byte for byte.** Both ends derive it from `irohAlpnFor`
  ([shared/iroh.ts](../../../shared/iroh.ts)) as `thunderbolt/<protocol>/0`, so an ACP client cannot
  drive an MCP bridge: the QUIC handshake is refused.
- Each protocol gets its own secret key file under `~/.thunderbolt/iroh/`
  ([cli/src/iroh/paths.ts](../../../cli/src/iroh/paths.ts)): `identity` for ACP, `identity-<protocol>`
  otherwise, the legacy name kept so existing ACP pairings survive. Different NodeIds mean a stale
  address cannot resolve the wrong process.

### Two trust layers

A bridge admits a peer whose handshake-authenticated NodeId is in **either** place
([cli/src/iroh/bridge.ts](../../../cli/src/iroh/bridge.ts), `isConnectionAllowed`):

| Layer                    | Source                                                          | Notes                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account allowlist        | `GET /v1/devices/allowlist`, fetched with the stored credential | The trusted, non-revoked NodeIds of the account the CLI is logged in to. Cached in memory, refreshed on a 45s heartbeat. Checked first, and short-circuits.                     |
| Manual `iroh allow` file | A newline-delimited NodeId list                                 | Mandatory for Standalone (no account), cross-account, and CI use. When the CLI has no credential the account layer is simply absent and the bridge falls back without erroring. |

#### Self-enrollment: no manual `iroh allow` for your own machines

- `ensureSelfEnrollment` ([src/lib/iroh-enrollment.ts](../../../src/lib/iroh-enrollment.ts)) posts the
  app's dialer NodeId to `POST /v1/devices/me/node-id`, which pins the write to the session's bound
  device. A session can only declare its _own_ NodeId, and declaring one you cannot dial as grants
  nothing (proof of possession is the QUIC handshake).
- Best-effort: the transport awaits it before dialling but it warns rather than rejects, and the
  add-agent panel posts through `fireAndForgetSelfEnrollment`, so a failure never blocks the add.
  Manual pairing is the fallback.
- The bridge registers symmetrically via `POST /v1/devices/bridge`, creating a
  `device_type = 'bridge'` row named after the host. Subject to the per-account device cap (422), and
  refuses to resurrect a revoked identity (409, surfaced as `BridgeDeviceRevokedError` telling the
  user to remove it in Settings → Devices). Lifecycle:
  [powersync-account-devices.md](powersync-account-devices.md).

#### Revocation is mid-session, not just at connect

Each heartbeat re-checks open connections against the refreshed allowlist and closes those no longer
allowed. If the refresh omits the bridge's _own_ NodeId, the account has revoked this device:
auto-trust switches off entirely and every same-account session is torn down. Manual-file peers
survive, because manual trust is independent.

#### Pre-handshake budget

| Limit                     | Value                     | Scope      |
| ------------------------- | ------------------------- | ---------- |
| Connections               | 10 per 10s sliding window | per remote |
| Concurrent TLS handshakes | 16                        | global     |

A fresh identity per connection defeats the per-remote budget; the global cap is the CPU backstop
that holds regardless of identity. A separate ceiling of 16 concurrent agent subprocesses
([cli/src/commands/bridge.ts](../../../cli/src/commands/bridge.ts)) bounds what an _admitted_ peer can
spawn, so it is not part of this budget.

### The client secret is plaintext in localStorage

The app's iroh secret key lives at `iroh_acp_client_secret` in `localStorage` so the NodeId stays
stable and a bridge operator allowlists the app once. That secret _is_ the bridge access credential:
XSS-exfiltratable, and it outlives any patched XSS. The source file says so, with a TODO to move it
behind the encryption middleware.

`clearIrohClientSecret` wipes it, called from `clearLocalData` on sign-out, account deletion and
device revocation. It also bumps a generation counter so a bind still in flight cannot re-persist the
cleared secret.

## Backend: discovery and managed agents

### `GET /v1/agents`

[backend/src/agents/routes.ts](../../../backend/src/agents/routes.ts) answers with
`{ version: '1', agents, allowCustomAgents }`.

- Unauthenticated callers get 401; anonymous sessions get 403 `ANONYMOUS_DISCOVERY_FORBIDDEN` and
  fall back to the built-in agent only.
- `version` exists so the shape can evolve.
- `allowCustomAgents` mirrors the env below so a deployment can hide "+ Add Custom Agent" without a
  client build.

Visibility settings ([backend/src/config/settings.ts](../../../backend/src/config/settings.ts)):

| Env                      | Effect                                                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `ENABLED_AGENTS`         | Comma-separated descriptor ids to expose. Empty means all registered.                                                             |
| `ALLOW_CUSTOM_AGENTS`    | Echoed into both the discovery response and `GET /v1/config`; the UI hides the add-agent affordance when false.                   |
| `DISABLE_BUILT_IN_AGENT` | Surfaced **inverted** on `GET /v1/config` as `builtInAgentEnabled`; the client then omits the built-in agent from its agent list. |

Providers live in a module-level registry
([backend/src/agents/discovery.ts](../../../backend/src/agents/discovery.ts)). Registration is
side-effectful (`createHaystackRoutes()` registers during construction) and idempotent on `id`, so
HMR and repeated test setup cannot double-register. A provider whose `list()` throws is logged and
skipped.

`buildWebSocketUrl` derives descriptor scheme and host from `x-forwarded-proto` /
`x-forwarded-host`, so dev (`ws://localhost:8000`) and production behind a TLS proxy
(`wss://host/v1/...`) both work with no env pinning.

### Haystack / Deepset

The only managed-agent provider today. Each entry in the `HAYSTACK_PIPELINES` JSON array becomes a
`managed-acp` descriptor pointing at `/v1/haystack/ws?pipeline=<id>`
([backend/src/haystack/](../../../backend/src/haystack)):

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

The three id-like fields are not interchangeable:

| Field          | Is                                                            |
| -------------- | ------------------------------------------------------------- |
| `id`           | The public slug, appearing in the URL and in `ENABLED_AGENTS` |
| `pipelineName` | The Deepset URL slug                                          |
| `pipelineId`   | The Deepset UUID                                              |

**Parsing is fail-soft.** A missing, empty, malformed-JSON or schema-mismatched value yields zero
descriptors with a WARN log and no error ([provider.ts](../../../backend/src/haystack/provider.ts));
throwing would fail discovery for unrelated providers too. If pipelines do not appear, check the log
for `HAYSTACK_PIPELINES is not valid JSON` or `HAYSTACK_PIPELINES schema mismatch` first.

#### The `WS /v1/haystack/ws` wire

`HaystackAcpServer` ([acp-server.ts](../../../backend/src/haystack/acp-server.ts)) implements the agent
half of ACP over the socket's text frames, driving the Deepset pipeline over SSE
([sse-parser.ts](../../../backend/src/haystack/sse-parser.ts)).

- Auth is the same bearer subprotocol the client attaches, validated in `open()` rather than
  `beforeHandle`: Bun's adapter can invoke `beforeHandle` more than once per upgrade, `open()` runs
  exactly once per accepted socket.
- The carrier subprotocol is echoed back so strict clients see their offer accepted. The bearer entry
  is deliberately _not_, keeping it out of `WebSocket.protocol` and proxy response logs.

#### `GET /v1/haystack/files/:fileId`

Proxies Deepset file downloads with the server-side workspace key, streaming the body straight
through. File ids are constrained to `^[\w-]+$` before the upstream call. An upstream 401/403
becomes a 502: it means a misconfigured server key, and passing it through would send the client to
re-authenticate for no reason.

## Where the code lives

| Area                        | Path                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public client surface       | [src/acp/index.ts](../../../src/acp/index.ts)                                                                                                                                                                                    |
| Adapters                    | [acp-adapter.ts](../../../src/acp/acp-adapter.ts), [built-in-adapter.ts](../../../src/acp/built-in-adapter.ts)                                                                                                                   |
| Connection lifecycle        | [adapter-cache.ts](../../../src/acp/adapter-cache.ts), [adapter-slot.ts](../../../src/acp/adapter-slot.ts), [reconnect-scheduler.ts](../../../src/acp/reconnect-scheduler.ts), [termination.ts](../../../src/acp/termination.ts) |
| Transports                  | [src/acp/transports/](../../../src/acp/transports), [src/acp/iroh/](../../../src/acp/iroh)                                                                                                                                       |
| ACP → AI SDK translation    | [translators/acp-to-ai-sdk.ts](../../../src/acp/translators/acp-to-ai-sdk.ts)                                                                                                                                                    |
| Data access and seeding     | [src/dal/agents.ts](../../../src/dal/agents.ts), [src/db/seeding/seed-agents.ts](../../../src/db/seeding/seed-agents.ts)                                                                                                         |
| Settings UI                 | [src/components/settings/agents/](../../../src/components/settings/agents)                                                                                                                                                       |
| Wire contract               | [shared/acp-types.ts](../../../shared/acp-types.ts), [shared/iroh.ts](../../../shared/iroh.ts), [shared/ws-bearer.ts](../../../shared/ws-bearer.ts)                                                                              |
| Backend discovery           | [backend/src/agents/](../../../backend/src/agents)                                                                                                                                                                               |
| Backend managed agent       | [backend/src/haystack/](../../../backend/src/haystack)                                                                                                                                                                           |
| WebSocket relay             | [backend/src/proxy/ws.ts](../../../backend/src/proxy/ws.ts)                                                                                                                                                                      |
| CLI bridge and served agent | [cli/src/iroh/](../../../cli/src/iroh), [cli/src/acp/](../../../cli/src/acp)                                                                                                                                                     |
| wasm iroh client            | `crates/thunderbolt-acp-client` (built artifact committed at `src/acp/iroh/pkg`)                                                                                                                                                 |

## Further reading

- [cli/README.md](../../../cli/README.md): served agent toolset and workspace jail, the `wss` bridge's
  Origin + token gate and `THUNDERBOLT_APP_ORIGIN`, on-disk ACP session logs.
- [iroh-relay-self-hosting.md](iroh-relay-self-hosting.md): what a relay does, how to run one.
- [powersync-account-devices.md](powersync-account-devices.md): device table, `bridge` rows,
  revocation.
- [projects.md](projects.md): why ACP agents get project instructions but not the project tool.
- [multi-device-sync.md](multi-device-sync.md): which agent tables sync and which are local-only.
