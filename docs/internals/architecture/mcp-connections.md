# MCP Connections

Thunderbolt is an MCP **client**. A Model Context Protocol server added in Settings → Connections
(`/settings/connections`, routed in [src/app.tsx](../../../src/app.tsx)) has its tools merged into the
model's toolset on every send.

## Transports

| `type`  | SDK transport                   | Routing                                                                         |
| ------- | ------------------------------- | ------------------------------------------------------------------------------- |
| `http`  | `StreamableHTTPClientTransport` | Universal proxy on web; direct upstream on Tauri with the proxy off             |
| `sse`   | `SSEClientTransport`            | Same as `http`                                                                  |
| `iroh`  | `createMcpIrohTransport`        | Peer-to-peer over an iroh relay; no URL, proxy, or bearer applies               |
| `stdio` | none                            | In the enum, never connected ([below](#stdio-is-in-the-enum-but-not-connected)) |

- `createMcpTransport` ([src/lib/mcp-transport.ts](../../../src/lib/mcp-transport.ts)) is the single
  construction point, shared by the provider and the add form's Test Connection probe, so the probe
  exercises the real path.
- `SSEClientTransport` is `@deprecated` in the SDK, kept as the only way to reach legacy SSE-only
  servers.

### The proxy hop (`http` / `sse`)

Remote MCP traffic rides the universal proxy like a BYOK LLM call; there is no MCP-specific backend
route. [`e2e/proxy-mcp.spec.ts`](../../../e2e/proxy-mcp.spec.ts) pins the JSON-RPC POST to `/v1/proxy`
with the server URL in `X-Proxy-Target-Url`, never a per-server `/mcp-proxy/…` path.

- `createProxyFetch` ([src/lib/proxy-fetch.ts](../../../src/lib/proxy-fetch.ts)) wraps the SDK
  transport's `fetch` and picks the branch per call via `computeEffectiveProxyEnabled`: web always
  proxies (CORS), Tauri honours `proxy_enabled`.
- Two credentials: the session bearer authenticates the request to `/v1/proxy` (401 without it), and
  the upstream MCP credential rides a **plain** `Authorization` header from `buildMcpHeaders` that
  `createProxyFetch` promotes to `X-Proxy-Passthrough-Authorization`. Setting the passthrough header
  at the transport loses it: `buildHostedRequest` skips caller headers already beginning with
  `x-proxy-`.

### Localhost is reachable on Tauri, not on web

| Layer                                                                                                  | Rule                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validateMcpServerUrl` ([src/lib/mcp-url-validation.ts](../../../src/lib/mcp-url-validation.ts))       | `http`/`https` only; `https` required for a public host; plain `http://` allowed for loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) and RFC 1918 / IPv6-ULA private addresses |
| `normaliseTargetUrl` ([backend/src/proxy/routes.ts](../../../backend/src/proxy/routes.ts))             | Upgrades `http:` to `https:` via `ensureHttps`                                                                                                                                             |
| `validateAndPin` ([backend/src/utils/url-validation.ts](../../../backend/src/utils/url-validation.ts)) | Resolves the host and refuses private or internal addresses                                                                                                                                |

The client rule describes what the _device_ can reach (every IPv4 octet must parse numerically, so
`127.0.0.1.evil.com` is not loopback); the proxy rules are an SSRF control.

So a `http://localhost:…` server works on Tauri with the proxy off (and `native_fetch` compiled in),
fails on web, and nothing warns at save time. Use an iroh bridge across machines; same trap as ACP
("The relay will not carry a loopback bridge" in [acp-agents.md](acp-agents.md)).

### iroh

[src/lib/mcp-iroh-transport.ts](../../../src/lib/mcp-iroh-transport.ts) reuses the ACP iroh stack
verbatim (lazy wasm relay client, ndjson framing) and adapts the bidi byte stream to the SDK's
callback-based `Transport`.

- **ALPN:** `irohAlpnFor('mcp')` → `thunderbolt/mcp/0` ([shared/iroh.ts](../../../shared/iroh.ts)). Must
  match the bridge byte for byte, so an MCP client cannot drive an ACP bridge.
- **Enrolment:** the transport best-effort enrols this device's NodeId before dialling, so the user
  need not run `thunderbolt iroh allow` for their own machines.
- **Detection by shape, not dropdown:** `isIrohTarget`
  ([src/lib/iroh-target.ts](../../../src/lib/iroh-target.ts)) treats any single lowercase-base32 token of
  52+ characters as a NodeId or `EndpointTicket`. The add form then hides the transport select, the
  credential field, and the probe (the link is encrypted and allowlist-gated, verified on first use).

MCP inherits the trust model, allowlist, and relay operation documented in
[acp-agents.md](acp-agents.md) and [iroh-relay-self-hosting.md](iroh-relay-self-hosting.md).

### stdio is in the enum but not connected

`mcp_servers.type` accepts `'stdio'` ([src/db/tables.ts](../../../src/db/tables.ts)), but nothing
connects one: `getRemoteMcpServers` filters to `http | sse | iroh`, the add form offers no stdio
option, and the JSON importer rejects a `command`/`args` entry ("local/stdio servers are not supported
yet", THU-575).

Use the CLI bridge instead: `thunderbolt mcp --transport iroh -- <server-cmd…>`
([cli/src/cli.ts](../../../cli/src/cli.ts)) spawns the stdio server per accepted connection and exposes it
as an iroh target.

### Upgrade check: the `protocolVersion` shim

`installProtocolVersionSetter` ([src/lib/mcp-transport.ts](../../../src/lib/mcp-transport.ts)) shadows
`protocolVersion` on every http/sse transport with a settable accessor delegating to
`setProtocolVersion()`. `@ai-sdk/mcp`'s `init()` assigns the negotiated version directly;
`@modelcontextprotocol/sdk` (>= 1.25) made `protocolVersion` getter-only.

Without the shim **every** remote MCP connect fails with
`TypeError: Cannot set property protocolVersion …`, with no TypeScript error either way, so check it
when upgrading either package. Deletable once `@ai-sdk/mcp` stops assigning (only the AI-SDK-v6
`2.0.0-beta` line does, which would force a major upgrade of the v5 stack).

## Servers and secrets are device-local

Both MCP tables are registered in `localOnlyTables`
([src/db/powersync/schema.ts](../../../src/db/powersync/schema.ts)) and never leave the device:

| Table         | Holds                                                                         | Why local                                                      |
| ------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `mcp_servers` | Name, `type` (transport), URL or iroh target, enabled flag, soft-delete stamp | A server row without its credential is unconnectable elsewhere |
| `mcp_secrets` | One credential blob per server id: a bearer token, or the OAuth token set     | It is a credential                                             |

The wider rule (nothing carrying a credential may join `syncedTables`) and the regression test pinning
these two ([src/db/powersync/schema.test.ts](../../../src/db/powersync/schema.test.ts)) are in
[multi-device-sync.md](multi-device-sync.md).

- One transaction writes both halves (`createMcpServerWithCredentials` /
  `updateMcpServerWithCredentials`, [src/dal/mcp-servers.ts](../../../src/dal/mcp-servers.ts)): the
  provider reads the secret at connect time, so a partial write orphans the secret or connects
  unauthenticated.
- Deleting soft-deletes the `mcp_servers` row (scrubbing its nullable columns) and hard-deletes the
  `mcp_secrets` row in the same transaction.
- `getMcpServerCredentialRows` ([src/dal/mcp-secrets.ts](../../../src/dal/mcp-secrets.ts)) projects blobs
  in SQL down to `{ id, type, bearerToken }`; those rows reach the settings page's query cache.
- Export includes both tables; import writes them locally without uploading
  ([export-format.md](export-format.md)).
- Sign-out, account deletion, and device revocation run `clearLocalData`
  ([src/lib/cleanup.ts](../../../src/lib/cleanup.ts)), whose database reset deletes the file both tables
  live in.

## Authentication

### Credential precedence

`decideTestConnectionResult`
([src/lib/mcp-auth/auth-decision.ts](../../../src/lib/mcp-auth/auth-decision.ts)) encodes the add form's
precedence:

| Probe outcome    | Meaning                                                                | UI                                   |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------ |
| `token-rejected` | 401 **with** a credential, so the static token is wrong                | Generic failure, no Authorize button |
| `needs-oauth`    | 401, no credential, AS supports DCR or CIMD                            | "Add & Authorize"                    |
| `needs-token`    | 401, no credential, OAuth advertised but no usable client registration | Ask for a PAT / API key              |
| `error`          | Anything else, including a 401 with no discoverable OAuth              | Generic failure                      |

- A bare 401 cannot distinguish "wants OAuth" from "wrong token", so a user-supplied credential wins
  and OAuth discovery runs only when there is none.
- `needs-token` covers servers like GitHub: RFC 9728 metadata, but an AS with neither Dynamic Client
  Registration nor CIMD, so the SDK cannot obtain a client and an Authorize button would only fail
  cryptically.
- `deriveOAuthCardDecision` applies the same fix on the server card: a _bearer_ server's 401 shows a
  connection error, an OAuth or credential-less 401 shows "needs auth".
- 401 detection is structural (`code === 401`, `name === 'UnauthorizedError'`, message fallbacks), not
  `instanceof`; verified SDK failure shapes are listed in
  [src/lib/mcp-errors.ts](../../../src/lib/mcp-errors.ts). The provider logs 401 at `warn`: a server
  awaiting authorization is expected, not broken.

### OAuth 2.1 discovery and registration

[src/lib/mcp-auth/web-oauth-flow.ts](../../../src/lib/mcp-auth/web-oauth-flow.ts) composes the SDK's auth
primitives instead of its `auth()` driver, because the redirect leg differs per platform; it mirrors
the driver's registration precedence.

- **Discovery:** RFC 9728 (Protected Resource Metadata) then RFC 8414 (Authorization Server Metadata).
  Rejects the server if the discovered `issuer` differs from the URL it was fetched from, or the AS
  does not advertise PKCE `S256`.
- **Scopes:** the resource's `scopes_supported` requested verbatim. Otherwise a scope-gated server
  (Metabase gates every tool behind `agent:*`) issues a token authorized for nothing and `tools/list`
  comes back empty.
- **Registration:** Dynamic Client Registration. CIMD (SEP-991) is wired but held behind
  `cimdEnabled = false` in
  [src/lib/mcp-auth/oauth-client-provider.ts](../../../src/lib/mcp-auth/oauth-client-provider.ts): the
  client-metadata document is not hosted, and CIMD needs the AS to fetch it server-side from a stable
  production HTTPS origin. Do not re-enable before it exists.

### Redirect strategies, one per platform

| Platform      | Redirect URI                                | How the callback arrives                             |
| ------------- | ------------------------------------------- | ---------------------------------------------------- |
| Desktop Tauri | `http://localhost:PORT`, learned at runtime | Rust loopback server, one request then self-shutdown |
| Mobile Tauri  | `https://app.thunderbolt.io/oauth/callback` | Verified App Link / Universal Link deep link         |
| Web           | `${origin}/oauth/callback`                  | Full-page redirect back into the app                 |

**The mobile redirect URI is externally registered**: a verified App Link / Universal Link bound to
`app.thunderbolt.io`, and the deep-link parser
([src/hooks/use-deep-link-listener.ts](../../../src/hooks/use-deep-link-listener.ts)) accepts only that
host and path, so changing it is not a one-line client edit. Mobile opens the _system_ browser, never
the webview.

Desktop ([src/lib/mcp-auth/mcp-oauth-loopback.ts](../../../src/lib/mcp-auth/mcp-oauth-loopback.ts)) binds
the Rust server before registration so the port (and the redirect URI) is known, registers the
`oauth-callback` listener _before_ opening the browser to avoid losing a fast callback, and times out
at 5 minutes. It exchanges the token inline, so `startMcpOAuthFlow` returns
`{ status: 'completed' }` on desktop and `{ status: 'redirected' }` everywhere else.

### The handshake slot

The handshake lives in `localStorage` under `mcp_oauth_flow_state`
([src/lib/mcp-auth/mcp-oauth-state.ts](../../../src/lib/mcp-auth/mcp-oauth-state.ts)), not
`sessionStorage`: the web leg is a full-page `window.location.assign`, and iOS/Android may terminate
the app mid-browser. It is single-use, read-then-cleared before the exchange, so a replayed callback
cannot double-exchange the code.

One slot, so one authorization in flight. Two guards, both needed:

- `assertNoConcurrentFlow` refuses to start while a _different_ server's handshake is pending and
  younger than `abandonedFlowMs` (10 minutes); older ones count as abandoned, so a closed tab does not
  block authorization forever.
- `desktopLoopbackInProgress`, a module-level flag, covers the window _before_ the handshake is written
  (desktop runs the loopback server and discovery/registration first), or a second Authorize click
  could stand up a competing loopback server. Mirrors `loopbackActiveRef` in
  [src/hooks/use-oauth-connect.ts](../../../src/hooks/use-oauth-connect.ts).

The authorization server and its metadata are **pinned at start** and reused at callback:
re-discovering after the redirect would let a malicious resource server vary its PRM between the
halves and steer the code-plus-verifier exchange to an endpoint it controls.

`validateMcpOAuthCallback`
([src/lib/mcp-auth/callback-validation.ts](../../../src/lib/mcp-auth/callback-validation.ts)) then checks
`state` against the stored nonce (RFC 6749 §10.12) and `iss` against the pinned issuer (RFC 9207),
assert-and-reject both: a missing stored nonce is a rejection, never a pass, and an absent `iss` is
rejected whenever the AS advertised `authorization_response_iss_parameter_supported`.

### Callback routing

`/oauth/callback` is shared with the Google/Microsoft integrations flow. `isMcpOAuthCallback` claims a
callback by **handshake ownership**, not by the shared `oauth_flow_state` slot (which the MCP flow
never writes).

- With a `code`: claimed only on an exact nonce match, keeping the exchange strictly CSRF-gated.
- An _error_ callback with no code: also claimed when a fresh MCP handshake is pending and it is not
  the pending integrations flow's. RFC 6749 §4.1.2.1 requires the AS to echo `state` on error
  redirects, but non-compliant ones exist, and an unclaimed error would block every other server until
  `abandonedFlowMs` elapsed.

The web callback component
([src/components/oauth-callback.tsx](../../../src/components/oauth-callback.tsx)) and the deep-link
listener share the predicate, and both coalesce `error_description || error` so a description-only
error is not misrouted.

### Token refresh

`ensureValidMcpOAuthToken`
([src/lib/mcp-auth/ensure-valid-token.ts](../../../src/lib/mcp-auth/ensure-valid-token.ts)) refreshes
within 60s of expiry, sends the RFC 8707 `resource`, and stores the rotated refresh token. Concurrent
callers for one server share one in-flight refresh: OAuth 2.1 reuse-detection rejects a second
presentation of a rotating refresh token with `invalid_grant`, which would otherwise force a needless
re-authorization. A
genuine `invalid_grant` becomes `McpOAuthNeedsReauthError`, rendered by the server card as
"Re-authorize".

`defaultCreateClient` re-reads `mcp_secrets` on every connect, so nothing pushes a refreshed token
into a live client.

## Connection lifecycle

The database is the source of truth; live clients are a projection. `useMcpSync`
([src/hooks/use-mcp-sync.tsx](../../../src/hooks/use-mcp-sync.tsx)) watches `getRemoteMcpServers` and
reconciles `MCPProvider` ([src/lib/mcp-provider.tsx](../../../src/lib/mcp-provider.tsx)) against each
snapshot: add, remove, or patch.

- The reconcile body sits in `useEffectEvent` so the effect depends on the query result alone; keyed on
  the provider callbacks or on `servers` it would re-fire every provider render and race the async
  `updateServer` it had just started.
- Both mount once, globally, in [src/app.tsx](../../../src/app.tsx): `MCPProvider` around the app,
  `useMcpSync` inside `AppContent`. The settings page reads provider state but deliberately runs no
  sync of its own, which would double-register every server.

`serversRef` is the provider's synchronous source of truth and `commitServers` its sole writer, so
async code re-checks it after an `await` instead of waiting for a React flush. The invariants concern
overlapping work:

- Connects and reconnects are **coalesced** per server id. Otherwise two consumers firing
  enable→connect before a flush leak the first connection under a cached second client.
- A connect whose server was removed or disabled mid-flight **closes the orphan** rather than caching
  (and silently re-enabling) it.
- `updateServer` always applies the row patch, redialing only when it must: disabled → disconnect,
  re-enabled → connect, endpoint changed → reconnect, pure rename → nothing. A caller that just wrote
  credentials passes `forceRedial`; if an initial connect is in flight it chains onto it, so the
  credential write is not stranded behind a connect that read the old value.

Recovery is at the `tools()` boundary, not on a timer: `mergeMcpTools`
([src/ai/fetch.ts](../../../src/ai/fetch.ts)) catches an expected discovery error (`isMcpDiscoveryError`),
skips that server's tools for the current send, and kicks off one background reconnect. Unexpected
errors propagate.

## Tool namespacing and attribution

Tools merge as `<prefix>_<toolName>`; the prefix is the server name through `sanitizeToolPrefix`
(lowercased, non-alphanumerics collapsed to `_`, empty → `mcp`).

- Colliding prefixes disambiguate upward (`render`, `render_2`), with every final prefix reserved so a
  later server that itself sanitizes to `render_2` is bumped again.
- A tool name that still collides with a registered tool is skipped; first registration wins.
- Per-server tool counts are summarized into the system prompt.

`mergeMcpTools` owns the name→server mapping and returns an `mcpTools` map (`<prefix>_<tool>` →
`{ name, url, toolName }`). `createMessageMetadata`
([src/ai/message-metadata.ts](../../../src/ai/message-metadata.ts)) attaches, per `tool-call`, only the
entry for the tool actually invoked.

Chat history resolves a `dynamic-tool` part by exact lookup in `getMcpToolDisplay`
([src/lib/mcp-tool-display.ts](../../../src/lib/mcp-tool-display.ts)); no prefix heuristics. The URL picks
a brand glyph from [src/lib/mcp-icons.ts](../../../src/lib/mcp-icons.ts), else a generic one. Messages
predating the map fall back to the prettified full tool name.

## JSON config import

The add form's **Advanced (JSON)** mode accepts a pasted `mcpServers` config (the VS Code `servers` key
also works), parsed by [src/lib/mcp-config-import.ts](../../../src/lib/mcp-config-import.ts).

- All-or-nothing: malformed JSON, a missing root key, a stdio entry, or a URL the reachability rule
  rejects fails the whole import with a per-entry error list.
- `type` maps to the transport, defaulting to `http`.
- `disabled: true` imports the server switched off.
- An `Authorization: Bearer …` header becomes the stored bearer credential. Non-Bearer auth headers are
  ignored and the server is still imported; the form says so.

## Where the code lives

| Area                   | Path                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transport construction | [src/lib/mcp-transport.ts](../../../src/lib/mcp-transport.ts), [src/lib/mcp-iroh-transport.ts](../../../src/lib/mcp-iroh-transport.ts)                                                                      |
| Connection lifecycle   | [src/lib/mcp-provider.tsx](../../../src/lib/mcp-provider.tsx), [src/hooks/use-mcp-sync.tsx](../../../src/hooks/use-mcp-sync.tsx)                                                                            |
| OAuth                  | [src/lib/mcp-auth/](../../../src/lib/mcp-auth), [src/hooks/use-mcp-server-oauth.ts](../../../src/hooks/use-mcp-server-oauth.ts)                                                                             |
| Callback routing       | [src/components/oauth-callback.tsx](../../../src/components/oauth-callback.tsx), [src/hooks/use-deep-link-listener.ts](../../../src/hooks/use-deep-link-listener.ts)                                        |
| URL policy and probes  | [src/lib/mcp-url-validation.ts](../../../src/lib/mcp-url-validation.ts), [src/lib/mcp-connection-test.ts](../../../src/lib/mcp-connection-test.ts), [src/lib/mcp-errors.ts](../../../src/lib/mcp-errors.ts) |
| Data access            | [src/dal/mcp-servers.ts](../../../src/dal/mcp-servers.ts), [src/dal/mcp-secrets.ts](../../../src/dal/mcp-secrets.ts)                                                                                        |
| Settings UI            | [src/settings/connections/](../../../src/settings/connections), [src/hooks/use-add-server-form.ts](../../../src/hooks/use-add-server-form.ts)                                                               |
| Tool merge and display | [src/ai/fetch.ts](../../../src/ai/fetch.ts), [src/lib/mcp-tool-display.ts](../../../src/lib/mcp-tool-display.ts), [src/lib/mcp-icons.ts](../../../src/lib/mcp-icons.ts)                                     |
| Config import          | [src/lib/mcp-config-import.ts](../../../src/lib/mcp-config-import.ts)                                                                                                                                       |
| Proxy hop              | [src/lib/proxy-fetch.ts](../../../src/lib/proxy-fetch.ts), [backend/src/proxy/routes.ts](../../../backend/src/proxy/routes.ts), [shared/proxy-protocol.ts](../../../shared/proxy-protocol.ts)               |
| CLI bridge             | [cli/src/cli.ts](../../../cli/src/cli.ts), [cli/src/iroh/](../../../cli/src/iroh)                                                                                                                           |

## Further reading

- [acp-agents.md](acp-agents.md): iroh trust model, allowlist, the same loopback trap on ACP.
- [multi-device-sync.md](multi-device-sync.md): why these tables are local-only, and what else is.
- [export-format.md](export-format.md): `mcp_servers` / `mcp_secrets` in a backup/restore.
- [AGENTS.md](../../../AGENTS.md): the universal proxy's `allowedHeaders: true` CORS posture and the
  outer-hop headers (`X-App-Version`, `X-App-Language`) that must never reach an MCP upstream.
