# External memory providers

The Memory settings page and the main Connections page share the existing `mcp_servers` records, device-local MCP credentials, and generic MCP OAuth flow. The new catalog supplies provider names and endpoints; it adds no SDK, inference provider, token store, or background memory synchronization. The Memory page selects exactly one provider: Built-in or one configured MCP connection. Agents receive only that provider's memory capabilities. The built-in memory document remains in its own setting and is retained when another provider is selected.

## Supported providers

| Provider        | Remote endpoint                                     | Setup                                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supermemory     | `https://mcp.supermemory.ai/mcp`                    | Browser OAuth; the provider lets the user choose access to its memory spaces. [Official setup](https://supermemory.ai/mcp/)                                                                                                                                    |
| Mem0            | `https://mcp.mem0.ai/mcp/`                          | Browser OAuth for the hosted Mem0 service; a Mem0 Platform account is required. The canonical trailing slash also appears in its [direct MCP setup](https://docs.mem0.ai/integrations/codex). [Authentication options](https://docs.mem0.ai/platform/mem0-mcp) |
| Hindsight Cloud | `https://api.hindsight.vectorize.io/mcp/{bank_id}/` | Browser OAuth with an explicit memory-bank ID. The UI requires a bank to avoid silently creating or selecting the provider's default bank. [Official setup](https://docs.hindsight.vectorize.io/cloud/mcp/)                                                    |
| Zep             | `https://api.getzep.com/mcp`                        | Organization OAuth; the organization must configure MCP access and available seats. The provider selects the permitted project after sign-in. [Official setup](https://help.getzep.com/v4/context-mcp-server/connect)                                          |

These are remote Streamable HTTP connections. Authorization, PKCE, client registration, token refresh, callback routing, connection retry, and local credential storage reuse the app's [MCP connection architecture](mcp-connections.md). A user can configure a connection from the main Connections page before enabling memory; configuration does not turn memory on or replace the selected provider. The Memory page dims and disables its provider controls while Saved memories is off. The synced `memory_provider` setting stores `builtin` or `mcp:<server-id>`; namespacing prevents imported server IDs from colliding with Built-in. Missing selection defaults to Built-in. An unavailable, disabled, or removed selected connection never silently falls back to another provider.

## Discovery verification

On November 12, 2026, unauthenticated public endpoint checks and the installed MCP SDK's discovery functions reached all four providers' protected-resource and authorization-server metadata. All four advertised dynamic client registration, PKCE S256, authorization-code grants, and refresh grants. No registration request, account login, grant, or memory operation was performed. The user has no provider accounts yet and deferred account testing; these checks establish protocol compatibility, not successful account authorization.

| Provider    | Advertised resource audience             | Advertised token authentication                        |
| ----------- | ---------------------------------------- | ------------------------------------------------------ |
| Supermemory | `https://mcp.supermemory.ai/mcp`         | Public `none`, secret Basic/post, private-key JWT      |
| Mem0        | `https://mcp.mem0.ai/`                   | Secret post or Basic; public `none` was not advertised |
| Hindsight   | `https://api.hindsight.vectorize.io/mcp` | Public `none`, secret post or Basic                    |
| Zep         | `https://api.getzep.com/mcp`             | Public `none`, secret Basic or post                    |

The OAuth flow validates and selects the advertised resource using the MCP SDK, then pins that exact audience through authorization, code exchange, and refresh. A bank-specific Hindsight URL and Mem0's transport path must not replace the broader audience declared by their resource metadata. Older credentials without a pinned audience retain the existing server-URL fallback. Registration prefers public-client authentication; if a server only supports client secrets, it requests a compatible post/Basic method and retains the DCR-issued secret and method in the device-local credential store for refresh. Client secrets do not sync.

Mem0's `/mcp` responds to POST with HTTP 307 to `/mcp/`. The hosted proxy intentionally does not follow POST redirects, so the catalog uses the canonical trailing slash. Transport creation also normalizes existing Mem0 `/mcp` URLs without changing the saved connection URL or its privacy/provenance identity. Other providers and paths are left unchanged.

Zep's earlier HTTP 403 observation did not reproduce: the November 12 check returned HTTP 401 with a valid protected-resource challenge, followed by HTTP 200 discovery documents. Its public flow requests the advertised `graph:read`, `graph:write`, `agent:skill:read`, and `agent:skill:write` scopes. That does not prove a particular organization or user is admitted.

## Account prerequisites

- **Supermemory:** sign in and approve access to the desired spaces. Its hosted MCP uses OAuth; no API key or custom header is required. Tools use the active or account-default space. [Official setup](https://supermemory.ai/docs/supermemory-mcp/setup)
- **Mem0:** use a Mem0 Platform account and authorize through the browser. The service also documents a bearer API-key option, available through the app's generic MCP connection credential flow. [Official authentication](https://docs.mem0.ai/platform/mem0-mcp)
- **Hindsight Cloud:** create an account and supply the intended bank ID from its Connect page. The single-bank URL scopes tools to that bank. Root multi-bank mode otherwise silently defaults to a bank named `default`, which is why this setup form requires a bank. OAuth and bearer API keys are both documented. [Official connection modes](https://docs.hindsight.vectorize.io/cloud/mcp/)
- **Zep:** an administrator must enable a project's MCP connection and configure the work-email domain with Google Workspace or enterprise Custom OIDC; an ordinary dashboard login alone is insufficient. The account needs MCP seats, and exhausted seats reject new users. Custom OIDC requires an existing Zep user unless just-in-time provisioning is enabled. The selected project is fixed during authorization. Write tools depend on the administrator's write permission; reconnect after writes are enabled on a previously read-only grant. [Organization configuration](https://help.getzep.com/v4/context-mcp-server/authentication), [client connection](https://help.getzep.com/v4/context-mcp-server/connect)

## Consent and chat access

`src/memory/providers.ts` classifies the known providers' dedicated HTTPS origins independently of editable server names. The runtime uses that classification to gate all tools from the server when the server is not selected, memory is disabled, or a chat is missing or deleted, including tools that serve documents or other resource-like content. Legacy chat privacy flags impose no restrictions. The current MCP client does not expose separate MCP resource or prompt APIs; those nonexistent paths are not claimed as tested. Query parameters, encoded paths, and alternate endpoints on those origins cannot evade the classification. Connection setup still uses the canonical MCP endpoint. An unrelated server is not classified as a memory provider merely because its display name is “Mem0” or “Supermemory”.

The provider tool inventory is discovered dynamically instead of being copied into a local SDK or a fixed tool-name list. This matters because memory services also expose profile, graph, document, space, directive, and administrative tools. Gating only tools named “save memory” would leave other routes to the same memory service open.

## Logo provenance

The picker, setup form, Memory connection list, and main Connections list/detail use locally bundled official brand marks. No third-party logo service or remote image request is used at runtime. The downloaded assets are unchanged; only their display size is constrained, and the monochrome Supermemory mark is inverted in dark mode for contrast.

| Local asset                  | Official source                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/assets/supermemory.svg` | [Supermemory's site icon](https://supermemory.ai/favicon.svg?v=2), linked by its [MCP page](https://supermemory.ai/mcp/)                                                 |
| `src/assets/mem0.svg`        | [Mem0's documentation icon in its official repository](https://github.com/mem0ai/mem0/blob/main/docs/logo/favicon.svg)                                                   |
| `src/assets/hindsight.png`   | [Hindsight's documentation icon](https://docs.hindsight.vectorize.io/img/favicon.png), linked by its [MCP documentation](https://docs.hindsight.vectorize.io/cloud/mcp/) |
| `src/assets/zep.svg`         | [Zep's gradient icon in its official repository](https://github.com/getzep/zep/blob/main/assets/zep-logo-icon-gradient-rgb.svg)                                          |

## Tests

Provider tests cover trusted endpoint classification, lookalike domains, protocol and port mismatches, explicit Hindsight bank scoping, Mem0's canonical transport path, the four-provider picker, and each setup form's delegation to the generic MCP OAuth flow and shared records. OAuth fixtures cover resource audience validation and pinning, secret-post/Basic registration and refresh, cancellation during each preparation phase, and preserving a newer attempt's handshake. Browser tests exercise the Memory page's filtered picker and bank validation without creating provider accounts. Runtime privacy and consent tests are maintained with the memory access and MCP tool wrappers.

## Connection panels and cancellation

Memory providers use the same centered logo, connection button, Back/Continue footer, and responsive aside surface as other connection types. Connected status requires a live transport; saved OAuth credentials alone do not imply a working connection. Disabled accounts have an Enable action, failed transports have Retry, and authorization has Cancel. Closing or leaving setup aborts queued lookup, enable, discovery, exchange, and desktop loopback work; credential writes check the initiating identity and unchanged nondeleted endpoint inside a transaction. Explicitly canceled new connections remain retryable without credentials, while failed authorization rolls back its new row. Successful credentials survive a subsequent transport failure. Browser/mobile callback state restores the Memory connection aside, and cancellation clears only the nonce owned by that attempt.
