# MCP Connections

Thunderbolt is an MCP **client**. A user adds a Model Context Protocol server in Settings →
Connections (`/settings/connections`, routed in [src/app.tsx](../../src/app.tsx)), and from then on
that server's tools are merged into the model's toolset on every send. There is no MCP-specific
backend route: remote MCP traffic rides the universal proxy exactly like a BYOK LLM call.
[`e2e/proxy-mcp.spec.ts`](../../e2e/proxy-mcp.spec.ts) pins that from a real browser — the JSON-RPC
POST must land on `/v1/proxy` with the server URL in `X-Proxy-Target-Url`, never on a per-server
`/mcp-proxy/…` path.

This page covers the data model, the three transports and how each is routed, the OAuth
implementation, and the two places an upgrade or a URL can break a connection silently.

## Servers and secrets are device-local

Both MCP tables are registered in `localOnlyTables`
([src/db/powersync/schema.ts](../../src/db/powersync/schema.ts)) and therefore never leave the
device:

| Table         | Holds                                                                         |
| ------------- | ----------------------------------------------------------------------------- |
| `mcp_servers` | Name, `type` (transport), URL or iroh target, enabled flag, soft-delete stamp |
| `mcp_secrets` | One credential blob per server id — a bearer token, or the OAuth token set    |

`mcp_secrets` is local because it is a credential. `mcp_servers` is local for a second reason:
replicating a server row without its credential would hand every other device a server it cannot
connect to. [multi-device-sync.md](./multi-device-sync.md) covers the wider rule (nothing carrying a
credential may join `syncedTables`) and the regression test that pins these two
([src/db/powersync/schema.test.ts](../../src/db/powersync/schema.test.ts)).

Both halves are written in one transaction — `createMcpServerWithCredentials` /
`updateMcpServerWithCredentials` in [src/dal/mcp-servers.ts](../../src/dal/mcp-servers.ts) — because
the provider reads the secret at connect time, so a partial write would either orphan the secret or
connect unauthenticated. Deleting a server soft-deletes the `mcp_servers` row (scrubbing its
nullable columns) and hard-deletes the `mcp_secrets` row in the same transaction.

Credential blobs never leave the DAL as blobs: `getMcpServerCredentialRows`
([src/dal/mcp-secrets.ts](../../src/dal/mcp-secrets.ts)) projects them in SQL down to
`{ id, type, bearerToken }`, because those rows end up in the settings page's query cache.

Export includes both tables; import writes them locally without uploading. See
[export-format.md](./export-format.md). Signing out, deleting the account, or having the device
revoked all run `clearLocalData` ([src/lib/cleanup.ts](../../src/lib/cleanup.ts)), whose database
reset deletes the file both tables live in.

### stdio is in the enum but not connected

`mcp_servers.type` accepts `'stdio'` ([src/db/tables.ts](../../src/db/tables.ts)), but nothing
connects one: `getRemoteMcpServers` filters to `http | sse | iroh`, the add form offers no stdio
option, and the JSON importer rejects a `command`/`args` entry outright ("local/stdio servers are not
supported yet", THU-575). The way to reach a local stdio server today is the CLI bridge —
`thunderbolt mcp --transport iroh -- <server-cmd…>` ([cli/src/cli.ts](../../cli/src/cli.ts)), which
spawns the stdio server per accepted connection and exposes it as an iroh target.

## Three transports

`createMcpTransport` ([src/lib/mcp-transport.ts](../../src/lib/mcp-transport.ts)) is the single
construction point, shared by the provider and by the add form's Test Connection probe so the probe
exercises the real path.

| `type` | SDK transport                   | Routing                                                             |
| ------ | ------------------------------- | ------------------------------------------------------------------- |
| `http` | `StreamableHTTPClientTransport` | Universal proxy on web; direct upstream on Tauri with the proxy off |
| `sse`  | `SSEClientTransport`            | Same as `http`                                                      |
| `iroh` | `createMcpIrohTransport`        | Peer-to-peer over an iroh relay — no URL, proxy, or bearer applies  |

`SSEClientTransport` is `@deprecated` in the MCP SDK in favour of Streamable HTTP. It is retained
deliberately: it is the only way to reach legacy SSE-only servers and the SDK offers no
non-deprecated replacement for them.

The http/sse branch wraps the SDK transport's `fetch` in `createProxyFetch`
([src/lib/proxy-fetch.ts](../../src/lib/proxy-fetch.ts)). Two credentials are in play on that hop and
they must not be confused: the Thunderbolt session bearer authenticates the request to `/v1/proxy`
(without it the proxy returns 401), while the upstream MCP credential is set as a **plain**
`Authorization` header by `buildMcpHeaders` and promoted by `createProxyFetch` to
`X-Proxy-Passthrough-Authorization`. Setting the passthrough header at the transport instead would
lose the credential rather than save a step: `buildHostedRequest` skips every caller header already
beginning with `x-proxy-`, so it would be dropped, not forwarded.
`computeEffectiveProxyEnabled` decides the branch: web always proxies (CORS forces it), Tauri
honours the `proxy_enabled` toggle.

### The localhost reachability rule

`validateMcpServerUrl` ([src/lib/mcp-url-validation.ts](../../src/lib/mcp-url-validation.ts)) allows
only `http`/`https`, requires `https` for a public host, and permits plain `http://` for loopback
(`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) and for RFC 1918 / IPv6-ULA private addresses —
the dev and LAN endpoints that have no TLS to offer. Every IPv4 octet must parse numerically, so a
real DNS name like `127.0.0.1.evil.com` is not mistaken for loopback. The proxy that web traffic
must cross disagrees: `normaliseTargetUrl`
([backend/src/proxy/routes.ts](../../backend/src/proxy/routes.ts)) upgrades `http:` to `https:` via
`ensureHttps`, and `validateAndPin`
([backend/src/utils/url-validation.ts](../../backend/src/utils/url-validation.ts)) resolves the host
and refuses private or internal addresses.

Both sides are right in isolation — the form is describing what the _device_ can reach, the proxy is
an SSRF control on a server that would otherwise dial anything. The consequence is that a
`http://localhost:…` MCP server works on Tauri with the proxy toggle off (and the `native_fetch`
feature compiled in) and fails on web, and nothing warns you at save time. This mirrors the ACP
bridge's loopback problem; see "The relay will not carry a loopback bridge" in
[acp-agents.md](./acp-agents.md). When the app and the server are not on the same machine, use an
iroh bridge.

### iroh

[src/lib/mcp-iroh-transport.ts](../../src/lib/mcp-iroh-transport.ts) reuses the ACP transport's iroh
stack verbatim — the lazily-loaded wasm relay client and the ndjson framing — and adapts the raw bidi
byte stream to the SDK's callback-based `Transport` interface. The ALPN is
`irohAlpnFor('mcp')` → `thunderbolt/mcp/0` ([shared/iroh.ts](../../shared/iroh.ts)) and must match the
bridge byte for byte, so an MCP client cannot drive an ACP bridge. Before dialling, the transport
best-effort enrols this device's NodeId so the user does not have to run `thunderbolt iroh allow`
for their own machines.

An iroh target is recognised by shape rather than by a dropdown: `isIrohTarget`
([src/lib/iroh-target.ts](../../src/lib/iroh-target.ts)) treats any single lowercase-base32 token of
52 characters or more as a NodeId or `EndpointTicket`, and the add form then hides the transport
select, the credential field, and the probe (the link is encrypted and allowlist-gated, verified on
first use). The trust model, the allowlist, and relay operation are documented in
[acp-agents.md](./acp-agents.md) and
[iroh-relay-self-hosting.md](./iroh-relay-self-hosting.md) — MCP inherits all of it.

## Upgrade hazard: the `protocolVersion` shim

`installProtocolVersionSetter` in [src/lib/mcp-transport.ts](../../src/lib/mcp-transport.ts) shadows
`protocolVersion` on every http/sse transport with a settable accessor that delegates to the SDK's
`setProtocolVersion()`. It exists because `@ai-sdk/mcp`'s `init()` records the negotiated version by
direct assignment, while `@modelcontextprotocol/sdk` (>= 1.25) made `protocolVersion` a getter-only
accessor. Without the shim the assignment throws `TypeError: Cannot set property protocolVersion …`
and **every** remote MCP connect fails.

Treat it as a named check when upgrading either package: there is no TypeScript error either way, and
the failure is a runtime `TypeError` at connect. The shim can be deleted once `@ai-sdk/mcp` stops
assigning (only the AI-SDK-v6 `2.0.0-beta` line does, which would force a major upgrade of the v5
stack).

## Authentication

### Credential precedence

A bare 401 cannot distinguish "this server wants OAuth" from "your token is wrong", so the
user-supplied credential wins and OAuth discovery is consulted only when there is no credential.
`decideTestConnectionResult` ([src/lib/mcp-auth/auth-decision.ts](../../src/lib/mcp-auth/auth-decision.ts))
encodes that precedence for the add form:

| Probe outcome    | Meaning                                                                | UI                                   |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `token-rejected` | 401 **with** a credential — the static token is wrong                  | Generic failure, no Authorize button |
| `needs-oauth`    | 401, no credential, AS supports DCR or CIMD                            | "Add & Authorize"                    |
| `needs-token`    | 401, no credential, OAuth advertised but no usable client registration | Ask for a PAT / API key              |
| `error`          | Anything else, including a 401 with no discoverable OAuth              | Generic failure                      |

`needs-token` exists for servers like GitHub, which publish RFC 9728 metadata but whose authorization
server supports neither Dynamic Client Registration nor CIMD — the SDK cannot obtain a client there,
so an Authorize button would only produce a cryptic registration failure.
`deriveOAuthCardDecision` applies the same conflation fix on the server card: a _bearer_ server that
401s shows a connection error, an OAuth or credential-less server that 401s shows "needs auth".

The 401 detection itself is structural (`code === 401`, `name === 'UnauthorizedError'`, plus message
fallbacks) rather than `instanceof` — see the verified list of SDK failure shapes in
[src/lib/mcp-errors.ts](../../src/lib/mcp-errors.ts). The provider logs a 401 at `warn`, not `error`:
a server waiting for authorization is expected, not broken.

### OAuth 2.1

[src/lib/mcp-auth/web-oauth-flow.ts](../../src/lib/mcp-auth/web-oauth-flow.ts) builds the flow
out of the SDK's individual auth primitives rather than calling the SDK's own `auth()` driver — the
redirect leg differs on each platform, and the flow mirrors the driver's registration precedence
itself. Discovery follows RFC 9728 (Protected Resource Metadata) → RFC 8414
(Authorization Server Metadata) and rejects the server when the discovered `issuer` does not equal the
URL it was fetched from, or when the AS does not advertise PKCE `S256`. The resource's
`scopes_supported` are requested verbatim: a scope-gated server (Metabase gates every tool behind
`agent:*`) otherwise issues a token authorized for nothing and `tools/list` comes back empty.

Client registration is Dynamic Client Registration today. The CIMD path (SEP-991) is wired but held
behind `cimdEnabled = false` in
[src/lib/mcp-auth/oauth-client-provider.ts](../../src/lib/mcp-auth/oauth-client-provider.ts): the
client-metadata document is not yet hosted, and CIMD requires the AS to fetch it server-side from a
stable production HTTPS origin, so it must not be re-enabled before that document exists.

Three redirect strategies, one per platform:

| Platform      | Redirect URI                                | How the callback arrives                             |
| ------------- | ------------------------------------------- | ---------------------------------------------------- |
| Desktop Tauri | `http://localhost:PORT`, learned at runtime | Rust loopback server, one request then self-shutdown |
| Mobile Tauri  | `https://app.thunderbolt.io/oauth/callback` | Verified App Link / Universal Link deep link         |
| Web           | `${origin}/oauth/callback`                  | Full-page redirect back into the app                 |

**The mobile redirect URI is externally registered** — it is a verified App Link / Universal Link
bound to `app.thunderbolt.io`, and the deep-link parser
([src/hooks/use-deep-link-listener.ts](../../src/hooks/use-deep-link-listener.ts)) only accepts that
exact host and path. Changing it is not a one-line client edit. Mobile also opens the _system_
browser and never navigates the webview.

Desktop's loopback flow ([src/lib/mcp-auth/mcp-oauth-loopback.ts](../../src/lib/mcp-auth/mcp-oauth-loopback.ts))
binds the Rust server first so the port — and therefore the redirect URI — is known before the client
is registered, registers the `oauth-callback` listener _before_ opening the browser to avoid losing a
fast callback, and gives the user 5 minutes. It then completes the token exchange inline, which is
why `startMcpOAuthFlow` returns `{ status: 'completed' }` on desktop and `{ status: 'redirected' }`
everywhere else.

### The handshake slot

The in-flight handshake lives in `localStorage` under `mcp_oauth_flow_state`
([src/lib/mcp-auth/mcp-oauth-state.ts](../../src/lib/mcp-auth/mcp-oauth-state.ts)) — not
`sessionStorage`, because the web leg is a full-page `window.location.assign` and because iOS/Android
may terminate the app while the user is in the system browser. It is single-use and read-then-cleared
before the token exchange, so a replayed callback cannot double-exchange the code.

It holds one slot, so only one MCP authorization can be in flight at a time. Two guards enforce that
at different points, and both are needed:

- `assertNoConcurrentFlow` refuses to start when a _different_ server's handshake is pending and
  younger than `abandonedFlowMs` (10 minutes). A handshake older than that is treated as abandoned
  and may be replaced, so a closed tab does not block authorization forever.
- `desktopLoopbackInProgress`, a module-level flag, covers the window _before_ the handshake is
  written — desktop starts the loopback server and runs discovery/registration first, and without
  this a second Authorize click could stand up a competing loopback server. It mirrors
  `loopbackActiveRef` in [src/hooks/use-oauth-connect.ts](../../src/hooks/use-oauth-connect.ts), the
  same guard on the integrations flow.

The discovered authorization server and its metadata are **pinned into the handshake at start** and
reused at callback. Re-discovering after the redirect would let a malicious resource server vary its
PRM between the two halves and steer the code-plus-verifier exchange to an endpoint it controls.

Before any exchange, `validateMcpOAuthCallback`
([src/lib/mcp-auth/callback-validation.ts](../../src/lib/mcp-auth/callback-validation.ts)) checks the
returned `state` against the stored nonce (RFC 6749 §10.12) and the returned `iss` against the pinned
issuer (RFC 9207). Both are assert-and-reject: a missing stored nonce is a rejection, never a
short-circuit pass, and an absent `iss` is rejected whenever the AS advertised
`authorization_response_iss_parameter_supported`.

### Callback routing

`/oauth/callback` is shared with the Google/Microsoft integrations flow, so a callback has to be
attributed. `isMcpOAuthCallback` claims it by **handshake ownership**, not by the shared
`oauth_flow_state` return-context slot (the MCP flow never writes that slot). A callback carrying a
`code` is claimed only on an exact nonce match, keeping the exchange path strictly CSRF-gated. An
_error_ callback with no code is also claimed when a fresh MCP handshake is pending and the callback
is not the pending integrations flow's — RFC 6749 §4.1.2.1 requires the AS to echo `state` on error
redirects, but non-compliant ones exist, and an unclaimed error would leave the handshake pending and
block every other server until `abandonedFlowMs` elapsed. Both the web callback component
([src/components/oauth-callback.tsx](../../src/components/oauth-callback.tsx)) and the deep-link
listener route through the same predicate, and both coalesce `error_description || error` into one
signal so a description-only error is not misrouted.

### Token refresh

`ensureValidMcpOAuthToken`
([src/lib/mcp-auth/ensure-valid-token.ts](../../src/lib/mcp-auth/ensure-valid-token.ts)) refreshes
proactively within 60s of expiry, sends the RFC 8707 `resource`, and writes the rotated refresh token
back. Concurrent callers for one server share a single in-flight refresh: OAuth 2.1 reuse-detection
rejects a second presentation of a rotating refresh token with `invalid_grant`, which would otherwise
force a needless re-authorization. A genuine `invalid_grant` surfaces as `McpOAuthNeedsReauthError`,
which the server card turns into a clean "Re-authorize".

Nothing has to push a refreshed token into a live client: `defaultCreateClient` re-reads
`mcp_secrets` on every connect, so the next reconnect picks it up.

## Connection lifecycle

The database is the source of truth; the live clients are a projection of it.
`useMcpSync` ([src/hooks/use-mcp-sync.tsx](../../src/hooks/use-mcp-sync.tsx)) watches
`getRemoteMcpServers` and reconciles `MCPProvider`
([src/lib/mcp-provider.tsx](../../src/lib/mcp-provider.tsx)) against each snapshot — add, remove, or
patch. The reconcile body is wrapped in `useEffectEvent` so the effect depends on the query result
alone; keyed on the provider callbacks or on `servers` it would re-fire on every provider render and
race the async `updateServer` it had just started. Both are mounted once, globally, in
[src/app.tsx](../../src/app.tsx) — `MCPProvider` wrapping the app and `useMcpSync` inside
`AppContent`. The settings page reads provider state but deliberately does not run its own sync,
which would double-register every server.

Inside the provider, `serversRef` is the synchronous source of truth and `commitServers` is its sole
writer, so async code can re-check it after an `await` instead of waiting for a React flush. That
matters because the invariants here are all about overlapping work:

- Connects and reconnects are **coalesced** per server id. Two consumers can fire the
  enable→connect path before React flushes, and without coalescing the second `createClient` would
  cache over a live client and leak the first connection.
- A connect whose server was removed or disabled while it was in flight **closes the orphan** rather
  than caching (and silently re-enabling) it.
- `updateServer` always applies the row patch but only redials when it must: disabled → disconnect,
  re-enabled → connect, endpoint changed → reconnect, and a pure rename → nothing. A caller that
  just wrote credentials passes `forceRedial` so the new token is not left sitting unused in
  `mcp_secrets`; when an initial connect is still in flight it chains onto it, so the credential
  write is not stranded behind a connect that read the old value.

Recovery happens at the `tools()` boundary rather than on a timer. `mergeMcpTools`
([src/ai/fetch.ts](../../src/ai/fetch.ts)) catches an expected discovery error
(`isMcpDiscoveryError`), skips that server's tools for the current send, and kicks off one background
reconnect for the next one. Unexpected errors propagate.

## Tool namespacing and attribution

Each server's tools are merged as `<prefix>_<toolName>`, where the prefix is the server name
sanitized by `sanitizeToolPrefix` (lowercased, non-alphanumerics collapsed to `_`, empty → `mcp`).
Servers that sanitize to the same prefix are disambiguated upward — `render`, `render_2` — with every
final prefix reserved, so a later server that itself sanitizes to `render_2` is bumped again. A name
that still collides with an already-registered tool is skipped, first registration winning. The
per-server tool counts are summarized into the system prompt.

`mergeMcpTools` is also the only place that knows the exact name→server mapping, so it returns an
`mcpTools` map (`<prefix>_<tool>` → `{ name, url, toolName }`). `createMessageMetadata`
([src/ai/message-metadata.ts](../../src/ai/message-metadata.ts)) attaches, per `tool-call`, only the
entry for the tool actually invoked, so the saved assistant message carries the attribution it used
and nothing more. Chat history resolves a `dynamic-tool` part back to its server by exact lookup —
`getMcpToolDisplay` ([src/lib/mcp-tool-display.ts](../../src/lib/mcp-tool-display.ts)) — with no
display-time prefix heuristics; the URL picks the brand glyph from
[src/lib/mcp-icons.ts](../../src/lib/mcp-icons.ts), falling back to a generic one. Messages written
before the map existed fall back to the prettified full tool name.

## JSON config import

The add form's **Advanced (JSON)** mode accepts a pasted `mcpServers` config (the VS Code `servers`
key also works), parsed by [src/lib/mcp-config-import.ts](../../src/lib/mcp-config-import.ts). It is
all-or-nothing: malformed JSON, a missing root key, a stdio entry, or a URL the reachability rule
rejects fails the whole import with a per-entry error list, rather than half-importing. `type` maps to
the transport (defaulting to `http`), `disabled: true` imports the server switched off, and an
`Authorization: Bearer …` header becomes the stored bearer credential. Non-Bearer auth headers are
ignored, and the server is still imported — the form says so.

## Where the code lives

| Area                   | Path                                                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport construction | [src/lib/mcp-transport.ts](../../src/lib/mcp-transport.ts), [src/lib/mcp-iroh-transport.ts](../../src/lib/mcp-iroh-transport.ts)                                                                   |
| Connection lifecycle   | [src/lib/mcp-provider.tsx](../../src/lib/mcp-provider.tsx), [src/hooks/use-mcp-sync.tsx](../../src/hooks/use-mcp-sync.tsx)                                                                         |
| OAuth                  | [src/lib/mcp-auth/](../../src/lib/mcp-auth), [src/hooks/use-mcp-server-oauth.ts](../../src/hooks/use-mcp-server-oauth.ts)                                                                          |
| Callback routing       | [src/components/oauth-callback.tsx](../../src/components/oauth-callback.tsx), [src/hooks/use-deep-link-listener.ts](../../src/hooks/use-deep-link-listener.ts)                                     |
| URL policy and probes  | [src/lib/mcp-url-validation.ts](../../src/lib/mcp-url-validation.ts), [src/lib/mcp-connection-test.ts](../../src/lib/mcp-connection-test.ts), [src/lib/mcp-errors.ts](../../src/lib/mcp-errors.ts) |
| Data access            | [src/dal/mcp-servers.ts](../../src/dal/mcp-servers.ts), [src/dal/mcp-secrets.ts](../../src/dal/mcp-secrets.ts)                                                                                     |
| Settings UI            | [src/settings/connections/](../../src/settings/connections), [src/hooks/use-add-server-form.ts](../../src/hooks/use-add-server-form.ts)                                                            |
| Tool merge and display | [src/ai/fetch.ts](../../src/ai/fetch.ts), [src/lib/mcp-tool-display.ts](../../src/lib/mcp-tool-display.ts), [src/lib/mcp-icons.ts](../../src/lib/mcp-icons.ts)                                     |
| Config import          | [src/lib/mcp-config-import.ts](../../src/lib/mcp-config-import.ts)                                                                                                                                 |
| Proxy hop              | [src/lib/proxy-fetch.ts](../../src/lib/proxy-fetch.ts), [backend/src/proxy/routes.ts](../../backend/src/proxy/routes.ts), [shared/proxy-protocol.ts](../../shared/proxy-protocol.ts)               |
| CLI bridge             | [cli/src/cli.ts](../../cli/src/cli.ts), [cli/src/iroh/](../../cli/src/iroh)                                                                                                                        |

## Further reading

- [acp-agents.md](./acp-agents.md) — the iroh trust model, the allowlist, and the same loopback
  reachability trap on the ACP side.
- [multi-device-sync.md](./multi-device-sync.md) — why these tables are local-only and what else is.
- [export-format.md](./export-format.md) — how `mcp_servers` and `mcp_secrets` behave in a
  backup/restore.
- [AGENTS.md](../../AGENTS.md) — the universal proxy's `allowedHeaders: true` CORS posture and the
  outer-hop headers (`X-App-Version`, `X-App-Language`) that must never reach an MCP upstream.
