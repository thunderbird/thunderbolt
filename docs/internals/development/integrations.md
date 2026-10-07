# Integrations

An _integration_ is a third-party account the user connects so the model can act on data outside
Thunderbolt. Three live in [`src/integrations/`](../../../src/integrations):

| Provider                                | Scopes requested                                                                        | Tools                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Google** (Gmail + Calendar)           | `gmail.readonly`, `gmail.compose`, `calendar.readonly`, plus `openid`/`email`/`profile` | `google_check_inbox`, `google_search_emails`, `google_get_email`, `google_draft_email`, `google_check_calendar`        |
| **Microsoft** (Outlook mail + OneDrive) | `https://graph.microsoft.com/mail.read`, `User.Read`, `offline_access`                  | `microsoft_list_messages`, `microsoft_get_message`, `microsoft_search_onedrive`, `microsoft_get_onedrive_file_content` |
| **Thunderbolt** (web search + fetch)    | none (backend-hosted, no OAuth account of its own)                                      | `search`, `fetch_content`                                                                                              |

Scopes: [`google/auth.ts:37`](../../../src/integrations/google/auth.ts),
[`microsoft/auth.ts:37`](../../../src/integrations/microsoft/auth.ts). Tool tables:
[`google/tools.ts:546`](../../../src/integrations/google/tools.ts),
[`microsoft/tools.ts:335`](../../../src/integrations/microsoft/tools.ts),
[`thunderbolt-pro/tools.ts`](../../../src/integrations/thunderbolt-pro/tools.ts). That directory
name is historical; nothing gates on a subscription tier.

Each provider directory exports a `createConfigs` factory returning `ToolConfig[]`;
`getAvailableTools` ([`src/lib/tools.ts:39`](../../../src/lib/tools.ts)) decides per provider, at send
time, whether those configs join a turn. Gating matrix and the connected-vs-enabled distinction:
[Prompt and Tools](../architecture/prompt-and-tools.md#tools-what-exists-and-when).

## What connecting grants

Connecting is not a scoped, per-request permission: the consent screen hands the app a bearer token
for the mailbox, and every tool above runs against it unprompted. Tell users plainly:
**enabling the Google integration lets the model read and search their entire Gmail account and
write drafts into it.**

Three asymmetries in the table are load-bearing:

- **Nothing sends mail.** The only write is `google_draft_email`, a POST to
  `/gmail/v1/users/me/drafts`
  ([`google/tools.ts:410`](../../../src/integrations/google/tools.ts)); `gmail.compose` would permit
  sending, but no tool calls a send endpoint.
- **The Gmail reads are not `cacheable`, the Microsoft ones are.** A Gmail write can mutate state
  mid-turn, so a deduped read could go stale; Microsoft ships no mail- or drive-mutating tool today,
  and adding one must revisit those flags
  ([`microsoft/tools.ts:336`](../../../src/integrations/microsoft/tools.ts)).
  `google_check_calendar` is `cacheable`: nothing in a turn changes a calendar.
- **The Microsoft consent request covers mail, not files.** No Files scope is requested, yet
  `searchOneDrive` and `getOneDriveFileContent`
  ([`microsoft/tools.ts:213`](../../../src/integrations/microsoft/tools.ts),
  [`:251`](../../../src/integrations/microsoft/tools.ts)) call `/me/drive`, so they fail unless the
  tenant grants it another way. `getOneDriveFileContent` catches the 403 and reports
  `failure_reason: 'access_denied'`
  ([`microsoft/tools.ts:301`](../../../src/integrations/microsoft/tools.ts)); `searchOneDrive` has no
  such catch, so there the error propagates.

### How much payload reaches the model

| Payload                       | Limit                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| Gmail message bodies          | 4,000 chars (`truncateText`'s default, [`src/lib/utils.ts:265`](../../../src/lib/utils.ts)) |
| Calendar event descriptions   | 200 chars                                                                                   |
| Microsoft Graph payloads      | untruncated, as they arrive                                                                 |
| `getOneDriveFileContent` text | 16,000 chars (`llmContentCharLimit`, [`src/lib/utils.ts:260`](../../../src/lib/utils.ts))   |

`getOneDriveFileContent` reads only `text/*`. Other MIME types return metadata with
`extraction_failed: true`, `failure_reason: 'unsupported_type'` and a `file_category`, so the model
explains the limit instead of inventing content.

## Where the credentials live

OAuth tokens go to `integrations_secrets`, one row per provider
([`src/db/tables.ts:150`](../../../src/db/tables.ts)): a JSON blob (`access_token`, `refresh_token`,
`expires_at`, and a `profile` used only to show which account is connected) plus an `enabled` flag.
Primary key is the provider name: Drizzle field `provider`, column `id` (what raw SQL needs).

The table is registered `localOnly: true`
([`src/db/powersync/schema.ts:34`](../../../src/db/powersync/schema.ts)):

- **It never syncs.** Connecting Google on the laptop does not connect it on the phone; each device
  consents separately. Hence no entry in `encryptedColumnsMap`
  ([`src/db/encryption/config.ts:30`](../../../src/db/encryption/config.ts)), which governs only what
  leaves for the server. See [E2E Encryption](../architecture/e2e-encryption.md).
- **It is excluded from export** by `excludedFromExport`
  ([`src/dal/export.ts:25`](../../../src/dal/export.ts)); import records an `integrations_secrets` key
  in `ignoredTableNames` ([`src/dal/import.ts:229`](../../../src/dal/import.ts)) and the importing
  user re-authenticates. See [Export Format](../architecture/export-format.md).
- **Writes go through select-then-insert, not upsert.** PowerSync exposes local-only tables as
  SQLite views, which reject `ON CONFLICT`, hence the shape of `saveIntegrationCredentials`
  ([`src/dal/integrations.ts:55`](../../../src/dal/integrations.ts)).

### Disconnecting vs. toggling off

| Action     | Effect                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disconnect | `deleteIntegrationCredentials` ([`src/dal/integrations.ts:110`](../../../src/dal/integrations.ts)), a local `DELETE`. **No revocation is sent to the provider**; the grant survives until revoked in that account |
| Toggle off | Keeps the tokens, clears `enabled`, withdraws the tools from the model ([`src/dal/integrations.ts:98`](../../../src/dal/integrations.ts))                                                                         |

## The connect flow

All three platforms run authorization-code-with-PKCE and differ only in how the redirect returns.
`useOAuthConnect` ([`use-oauth-connect.ts:186`](../../../src/hooks/use-oauth-connect.ts)) branches on
platform:

| Platform        | Redirect target                             | How the code comes back                                                       |
| --------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| Web             | `${origin}/oauth/callback`                  | Full-page redirect; the callback route re-navigates in-app with `state.oauth` |
| Desktop (Tauri) | `http://localhost:<port>`                   | Rust loopback listener on 17421–17423 emits an `oauth-callback` Tauri event   |
| Mobile (Tauri)  | `https://app.thunderbolt.io/oauth/callback` | App Link / Universal Link, handled by the deep-link listener                  |

Web and mobile get their redirect URI from `getOAuthRedirectUri`
([`oauth-redirect.ts:16`](../../../src/lib/oauth-redirect.ts)); desktop ignores it and passes the
loopback URL it just bound ([`oauth-loopback.ts:45`](../../../src/lib/oauth-loopback.ts), ports at
[`src-tauri/src/commands.rs:100`](../../../src-tauri/src/commands.rs)). Desktop and mobile open the
**system** browser, not a webview, so the user authenticates where their session already is and can
see the real origin. Success stores the tokens with `enabled: true` in one step
([`use-oauth-connect.ts:155`](../../../src/hooks/use-oauth-connect.ts)): connecting implies enabling.

### Why the desktop ports are fixed

All three are pre-registered as redirect URIs in the provider consoles, so `bind_to_port` tries
each in turn and returns `AddrInUse` when all are taken
([`oauth_server.rs:30`](../../../src-tauri/src/oauth_server.rs)) instead of falling back to an
OS-assigned port the provider would reject. The listener accepts one connection and shuts itself
down, leaving the frontend nothing to clean up.

### Two details that bite

- **`buildAuthUrl` and `exchangeCodeForTokens` must receive the same `redirect_uri`.** The loopback
  port is known only at runtime, so it is threaded through both calls; providers reject the exchange
  when the two differ.
- **Flow state lives in `localStorage`, not `sessionStorage`.** Web and mobile persist `state` and
  the PKCE verifier across a navigation (desktop keeps them in the calling closure), and on Tauri
  mobile the OS can kill the app mid-flow, clearing `sessionStorage`. That rationale and the absence
  of a client-side TTL are recorded at
  [`src/lib/oauth-state.ts:11`](../../../src/lib/oauth-state.ts).

### Callback routing

MCP server authorization shares the callback URL, so callbacks route by `returnContext` and an MCP
callback is claimed by handshake ownership first
([`oauth-callback.tsx:69`](../../../src/components/oauth-callback.tsx)), which stops a concurrent
integration flow stealing it. See [MCP Connections](../architecture/mcp-connections.md).

### Where the flow starts

Besides Settings → Connections, two surfaces launch it:

- **The onboarding auth step**, which passes `setPreferredName: true` and seeds `preferred_name`
  from the OAuth profile
  ([`onboarding-auth-step.tsx:51`](../../../src/components/onboarding/onboarding-auth-step.tsx)).
- **The `connect-integration` widget**, emitted when the user asks for something mail- or
  calendar-shaped and the tools are absent
  ([`instructions.ts`](../../../src/widgets/connect-integration/instructions.ts)). On completion,
  [`use-handle-integration-completion.ts`](../../../src/hooks/use-handle-integration-completion.ts)
  replays the original user message.

## Token refresh

Tools never read the stored `access_token`; they call `ensureValidOAuthToken`
([`oauth-credentials.ts:40`](../../../src/integrations/oauth-credentials.ts)), which reuses the token
while `expires_at` is more than 60 seconds away, refreshes through the backend otherwise, and writes
the new token back. A row with no `refresh_token` throws instead of degrading silently; the user
reconnects.

Google's authorization URL therefore sets `access_type=offline` **and** `prompt=consent`
([`google/auth.ts:67`](../../../src/integrations/google/auth.ts)): Google returns a refresh token only
on a consent grant, so forcing the consent screen keeps a re-connect from producing a token that
cannot be refreshed once it expires.

## The backend's role

The client never holds a client secret. `/v1/auth/google/*` and `/v1/auth/microsoft/*`
([`google.ts`](../../../backend/src/auth/google.ts),
[`microsoft.ts`](../../../backend/src/auth/microsoft.ts)) are a confidential-client proxy with three
session-authenticated routes:

| Route       | Purpose                                                                                 |
| ----------- | --------------------------------------------------------------------------------------- |
| `/config`   | Returns the public `client_id` and a `configured` boolean; cached client-side once true |
| `/exchange` | Adds the client secret to the authorization-code exchange                               |
| `/refresh`  | Same, for refresh-token grants                                                          |

`/exchange` validates the submitted `redirect_uri` against `isOAuthRedirectUriAllowed`
([`settings.ts:313`](../../../backend/src/config/settings.ts)): the CORS origin list plus
`https://app.thunderbolt.io`, plus any `http://localhost`/`127.0.0.1` port for the desktop loopback.
`/refresh` has no `redirect_uri` to check.

Both Microsoft grants also send a `scope` parameter, so
[`microsoft.ts:14`](../../../backend/src/auth/microsoft.ts) holds a second copy of the frontend's scope
string that **must stay in sync with it**, kept aligned by nothing but a comment.

## Configuring a deployment

`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`
([`settings.ts:214`](../../../backend/src/config/settings.ts), documented in
[Configuration](../../self-hosting/configuration.md#authentication)) are read by these routes and
nowhere else. No Better Auth social provider consumes them, so despite sitting in the auth section
they are not sign-in credentials: sign-in is email OTP (the emailed link carries the same code),
OIDC, or SAML ([Sign-in and waitlist](../architecture/sign-in-and-waitlist.md)).

Register redirect URIs with each provider for every platform you ship:

- the web origin's `/oauth/callback`
- `https://app.thunderbolt.io/oauth/callback` for mobile
- `http://localhost:17421`–`17423` for desktop

### When a provider is unconfigured

Omitting either half of a pair disables that provider: `/config` reports `configured: false`, and
`buildAuthUrl` throws `MisconfiguredOAuthError`, naming the missing env vars
([`src/lib/auth.ts:43`](../../../src/lib/auth.ts)). The UI lists all three providers unconditionally
([`use-integrations-controller.tsx:43`](../../../src/settings/connections/use-integrations-controller.tsx)),
so the user still sees a Connect button, which reports the misconfiguration when pressed.
