# Integrations

An _integration_ is a third-party account the user connects so the model can act on data that lives
outside Thunderbolt. Three live in [`src/integrations/`](../../src/integrations): **Google** (Gmail +
Calendar), **Microsoft** (Outlook mail + OneDrive), and **Thunderbolt Pro** (the backend-hosted web
`search` / `fetch_content` pair, which needs no OAuth account of its own).

Each provider directory exports a `createConfigs` factory returning `ToolConfig[]`.
`getAvailableTools` ([`src/lib/tools.ts:39`](../../src/lib/tools.ts)) is the consumer that matters at
send time, and it decides per-provider whether those configs join the turn. The gating
matrix and the connected-vs-enabled distinction are documented once, in
[Prompt and Tools](../architecture/prompt-and-tools.md#tools-what-exists-and-when) — this page covers
the part that is specific to integrations: what a connection grants, where the credentials live, and
how the OAuth flow differs per platform.

## What connecting grants

Connecting is not a scoped, per-request permission. The consent screen hands the app a bearer token
for the user's mailbox, and every tool below runs against it without further prompting. State that
plainly to users: **enabling the Google integration lets the model read and search the user's entire
Gmail account and write drafts into it.**

| Provider  | Scopes requested                                                                        | Tools                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Google    | `gmail.readonly`, `gmail.compose`, `calendar.readonly`, plus `openid`/`email`/`profile` | `google_check_inbox`, `google_search_emails`, `google_get_email`, `google_draft_email`, `google_check_calendar`        |
| Microsoft | `https://graph.microsoft.com/mail.read`, `User.Read`, `offline_access`                  | `microsoft_list_messages`, `microsoft_get_message`, `microsoft_search_onedrive`, `microsoft_get_onedrive_file_content` |

Scopes are declared in [`src/integrations/google/auth.ts:37`](../../src/integrations/google/auth.ts)
and [`src/integrations/microsoft/auth.ts:37`](../../src/integrations/microsoft/auth.ts); the tool
tables are at [`src/integrations/google/tools.ts:546`](../../src/integrations/google/tools.ts) and
[`src/integrations/microsoft/tools.ts:335`](../../src/integrations/microsoft/tools.ts).

Three asymmetries in that table are deliberate or load-bearing:

- **Nothing sends mail.** The only write is `google_draft_email`, a POST to
  `/gmail/v1/users/me/drafts` ([`src/integrations/google/tools.ts:410`](../../src/integrations/google/tools.ts)),
  so the worst a model can do unattended is leave a draft. The `gmail.compose` scope the token
  carries would also permit sending; no tool calls a send endpoint.
- **The Gmail reads are not `cacheable`, the Microsoft ones are.** Gmail has a write tool that can
  mutate state inside a single turn, so a deduped read could go stale; Microsoft ships no mail- or
  drive-mutating tool today. Adding one must revisit those flags — the reasoning is recorded inline at
  [`src/integrations/microsoft/tools.ts:336`](../../src/integrations/microsoft/tools.ts).
  `google_check_calendar` is `cacheable`: nothing in the turn can change a calendar.
- **The Microsoft consent request covers mail, not files.** The requested scopes include no Files
  permission, yet `searchOneDrive` and `getOneDriveFileContent`
  ([`src/integrations/microsoft/tools.ts:213`](../../src/integrations/microsoft/tools.ts),
  [`:251`](../../src/integrations/microsoft/tools.ts)) call `/me/drive` — so they fail unless the
  user's tenant supplies the permission another way. `getOneDriveFileContent` catches the 403 and
  reports `failure_reason: 'access_denied'` to the model
  ([`src/integrations/microsoft/tools.ts:301`](../../src/integrations/microsoft/tools.ts));
  `searchOneDrive` has no such catch, so there the error propagates.

Gmail payloads are truncated before they reach the model: message bodies at `truncateText`'s
4,000-character default ([`src/lib/utils.ts:265`](../../src/lib/utils.ts)) and calendar event
descriptions at 200. The Microsoft tools return Graph's payload as it arrives, untruncated, with one
exception: `getOneDriveFileContent` cuts text at `llmContentCharLimit` (16,000 —
[`src/lib/utils.ts:260`](../../src/lib/utils.ts)). It only reads `text/*`; every other MIME type
returns metadata with `extraction_failed: true`, `failure_reason: 'unsupported_type'` and a
`file_category`, so the model can explain the limit instead of inventing content.

## Where the credentials live

OAuth tokens are written to `integrations_secrets`, one row per provider
([`src/db/tables.ts:150`](../../src/db/tables.ts)). The primary key is the provider name — the
Drizzle field is `provider`, but the column it maps to is called `id`, which is what you need in raw
SQL. The row holds a JSON blob (`access_token`, `refresh_token`, `expires_at`, and a `profile` used
only to show which account is connected) plus an `enabled` flag.

The table is registered `localOnly: true`
([`src/db/powersync/schema.ts:34`](../../src/db/powersync/schema.ts)). Three consequences follow:

- **It never syncs.** Connecting Google on the laptop does not connect it on the phone; each device
  runs its own consent flow. This is also why the table has no entry in `encryptedColumnsMap`
  ([`src/db/encryption/config.ts:30`](../../src/db/encryption/config.ts)) — that map governs what is
  encrypted on the way out to the server, and these rows have no way out. See
  [E2E Encryption](../architecture/e2e-encryption.md).
- **It is excluded from export.** `excludedFromExport`
  ([`src/dal/export.ts:25`](../../src/dal/export.ts)) drops it, and import treats any
  `integrations_secrets` key in the file as unknown, recording it in `ignoredTableNames`
  ([`src/dal/import.ts:229`](../../src/dal/import.ts)); the importing user re-authenticates.
  Rationale in [Export Format](../architecture/export-format.md).
- **Writes go through select-then-insert, not upsert.** PowerSync exposes local-only tables as SQLite
  views, which reject `ON CONFLICT` — hence the shape of `saveIntegrationCredentials`
  ([`src/dal/integrations.ts:55`](../../src/dal/integrations.ts)).

Disconnecting calls `deleteIntegrationCredentials`
([`src/dal/integrations.ts:110`](../../src/dal/integrations.ts)), a single local `DELETE`. **No
revocation request is sent to the provider**, so the grant survives in the user's Google or Microsoft
account until they revoke it there. Toggling the switch instead of disconnecting keeps the tokens and
only clears `enabled`, which withdraws the tools from the model
([`src/dal/integrations.ts:98`](../../src/dal/integrations.ts)).

## The connect flow

All three platforms run authorization-code-with-PKCE and differ only in how the redirect gets back
into the app. `useOAuthConnect` ([`src/hooks/use-oauth-connect.ts:186`](../../src/hooks/use-oauth-connect.ts))
branches on platform:

| Platform        | Redirect target                             | How the code comes back                                                       |
| --------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| Web             | `${origin}/oauth/callback`                  | Full-page redirect; the callback route re-navigates in-app with `state.oauth` |
| Desktop (Tauri) | `http://localhost:<port>`                   | Rust loopback listener on 17421–17423 emits an `oauth-callback` Tauri event   |
| Mobile (Tauri)  | `https://app.thunderbolt.io/oauth/callback` | App Link / Universal Link, handled by the deep-link listener                  |

Web and mobile take their redirect URI from `getOAuthRedirectUri`
([`src/lib/oauth-redirect.ts:16`](../../src/lib/oauth-redirect.ts)). Desktop ignores that value and
passes the loopback URL it has just bound instead
([`src/lib/oauth-loopback.ts:45`](../../src/lib/oauth-loopback.ts)); the port list is in
[`src-tauri/src/commands.rs:100`](../../src-tauri/src/commands.rs). Desktop and mobile open the
**system** browser rather than a webview, so the user authenticates in a browser that already has
their session and can show the real origin.

The three desktop ports are fixed because they are pre-registered as redirect URIs in the provider
consoles: `bind_to_port` tries each in turn and returns `AddrInUse` when all are taken
([`src-tauri/src/oauth_server.rs:30`](../../src-tauri/src/oauth_server.rs)) rather than falling back
to an OS-assigned port the provider would reject. The listener accepts exactly one connection and
then shuts itself down, so the frontend has nothing to clean up.

Two details bite if you touch this code:

- **`buildAuthUrl` and `exchangeCodeForTokens` must receive the same `redirect_uri`.** The loopback
  port is only known at runtime, so it is threaded through both calls; providers reject the exchange
  when the two differ.
- **Flow state lives in `localStorage`, not `sessionStorage`.** The desktop loopback flow holds its
  `state` and verifier in the calling closure, but the web and mobile flows have to persist them
  across a navigation. On Tauri mobile the OS can kill the app while the user is in the system
  browser, and `sessionStorage` would be gone on relaunch —
  taking the PKCE verifier and the `state` nonce with it. The rationale and the absence of a
  client-side TTL are recorded at [`src/lib/oauth-state.ts:11`](../../src/lib/oauth-state.ts).

Callbacks are routed by `returnContext`, because MCP server authorization shares the same callback
URL; an MCP callback is claimed by handshake ownership first
([`src/components/oauth-callback.tsx:69`](../../src/components/oauth-callback.tsx)) so a concurrent
integration flow cannot steal it. See [MCP Connections](../architecture/mcp-connections.md).

A successful flow stores the tokens with `enabled: true` in one step
([`src/hooks/use-oauth-connect.ts:155`](../../src/hooks/use-oauth-connect.ts)), so connecting implies
enabling.

Two surfaces start the flow besides Settings → Connections: the onboarding auth step, which passes
`setPreferredName: true` and seeds the `preferred_name` setting from the OAuth profile
([`src/components/onboarding/onboarding-auth-step.tsx:51`](../../src/components/onboarding/onboarding-auth-step.tsx)),
and the `connect-integration` widget, which the model emits when the user asks for something mail- or
calendar-shaped and the tools are absent
([`src/widgets/connect-integration/instructions.ts`](../../src/widgets/connect-integration/instructions.ts)).
After the widget's flow completes,
[`use-handle-integration-completion.ts`](../../src/hooks/use-handle-integration-completion.ts)
replays the original user message so the request the user actually made goes through.

## Token refresh

Tools never read the stored `access_token` directly. They call `ensureValidOAuthToken`
([`src/integrations/oauth-credentials.ts:40`](../../src/integrations/oauth-credentials.ts)), which
reuses the token while `expires_at` is more than 60 seconds away, refreshes through the backend
otherwise, and writes the new token back to the row. A row with no `refresh_token` throws rather than
silently degrading — the user has to reconnect. Google's authorization URL therefore sets
`access_type=offline` **and** `prompt=consent`
([`src/integrations/google/auth.ts:67`](../../src/integrations/google/auth.ts)): Google returns a
refresh token only on a consent grant, so forcing the consent screen keeps a re-connect from
producing an access token that cannot be refreshed once it expires.

## The backend's role

The client never holds a client secret. `/v1/auth/google/*` and `/v1/auth/microsoft/*`
([`backend/src/auth/google.ts`](../../backend/src/auth/google.ts),
[`backend/src/auth/microsoft.ts`](../../backend/src/auth/microsoft.ts)) are a confidential-client
proxy with three session-authenticated routes:

| Route       | Purpose                                                                                 |
| ----------- | --------------------------------------------------------------------------------------- |
| `/config`   | Returns the public `client_id` and a `configured` boolean; cached client-side once true |
| `/exchange` | Adds the client secret to the authorization-code exchange                               |
| `/refresh`  | Same, for refresh-token grants                                                          |

`/exchange` validates the submitted `redirect_uri` against `isOAuthRedirectUriAllowed`
([`backend/src/config/settings.ts:313`](../../backend/src/config/settings.ts)) — the CORS origin list
plus `https://app.thunderbolt.io`, plus any `http://localhost`/`127.0.0.1` port for the desktop
loopback. `/refresh` has no `redirect_uri` to check. The Microsoft routes also send a `scope`
parameter on both grants, so [`backend/src/auth/microsoft.ts:14`](../../backend/src/auth/microsoft.ts)
holds a second copy of the frontend's scope string that **must stay in sync with it** — the code
says as much in a comment, which is the only thing keeping the two aligned.

## Configuring a deployment

`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET`
([`backend/src/config/settings.ts:214`](../../backend/src/config/settings.ts), documented in
[Configuration](../self-hosting/configuration.md#authentication)) are read by these integration
routes and nowhere else — no Better Auth social provider consumes them, so they are not sign-in
credentials despite their placement in the auth section. Sign-in is email OTP (the emailed link
carries the same code), OIDC, or SAML; see
[Sign-in and waitlist](../architecture/sign-in-and-waitlist.md).

Omitting either half of a pair disables that provider: `/config` reports `configured: false`, and
`buildAuthUrl` throws `MisconfiguredOAuthError`, whose message names the exact env vars the operator
is missing ([`src/lib/auth.ts:43`](../../src/lib/auth.ts)). The provider still appears in Settings →
Connections — the UI lists all three unconditionally
([`src/settings/connections/use-integrations-controller.tsx:43`](../../src/settings/connections/use-integrations-controller.tsx))
— so on an unconfigured deployment the user sees a Connect button that reports the misconfiguration
when pressed, rather than no entry at all.

The registered redirect URIs on the provider side must cover every platform you ship: the web
origin's `/oauth/callback`, `https://app.thunderbolt.io/oauth/callback` for mobile, and
`http://localhost:17421`–`17423` for desktop.
