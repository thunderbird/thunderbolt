# Standalone mode

Thunderbolt can run without a Thunderbolt backend or Docker deployment. Chats,
models, settings, projects, and the search index stay in the device's existing
local database. Connecting a server later does not replace that database.

## Startup and server selection

Fresh native installations start with an empty device-local `cloudUrl` and
`localMode: true`. Existing installations retain their saved URL. Managed SSO
builds retain their configured deployment. Web builds honor
`VITE_THUNDERBOLT_CLOUD_URL`; leaving it empty also starts a local installation.
`VITE_THUNDERBOLT_CLOUD_SERVICE_URL` separately overrides the Cloud choice
destination for development without connecting a fresh install automatically.

An empty `cloudUrl` means no server: config settles locally, auth reports no
session through an offline transport, and sync, session binding, and encryption
metadata requests are skipped. Relative backend requests reject locally instead
of falling through to the frontend's origin. `localMode` separately preserves
access to local routes after selecting an optional server; it never authorizes
backend requests.

Server selection validates an HTTP(S) URL and fetches its public `/v1/config`
before saving it. Old auth tokens and cached sessions are cleared before the
first connection. An unused server can be changed without deleting local data. The Change server
action reloads the app to discard pending authentication requests; backing out
of Cloud selection also clears its unused configuration.
Once a server has authenticated an account, changing it requires the existing
account/data teardown flow. HTTP and auth providers rebind on first connection,
including clients already captured by open chats.
In-flight authentication and configuration responses stay scoped to the server
that initiated them. Obsolete clients cannot read a newly selected server's bearer
token, persist a late session, or apply an old server's account/version errors.
Bearer credentials are stored atomically with their server URL. Existing bare
tokens remain readable for their original selection; newly issued tokens use
the scoped record. Request guards check shared storage as well as this window's
state, covering the interval before another window's storage event is delivered.
That event reloads stale windows onto the selected server.

The public config advertises the server's auth mode, anonymous-auth support, and
CAPTCHA provider. A generic downloaded client can therefore use email OTP or the
chosen server's SSO. A build pinned to enterprise SSO keeps that pin.

## Onboarding and providers

Local onboarding separates the connection choice from capability setup. The
three entry points are Cloud (show the embedded waitlist, with email
OTP sign-in for approved users), Local (continue without a
Thunderbolt server request), and Enterprise (show the server
address form, also usable for self-hosting).
The choice describes the whole environment, including tools and services, rather
than treating standalone as a model-only product. No server is selected merely
by opening this screen. Email-based server discovery is not part of this flow.

Device setup offers a configured and tested model connection, with Skip available on provider selection and connection screens, followed by
optional Exa, Brave, or Tavily search setup. A provider dropdown reveals its API-key field; Test connection runs one small search through the same transport used by agents and saves only on success. Editing either input requires another test. Skip continues without a provider. OpenRouter connects through browser authorization
with PKCE, with manual authorization-code entry on mobile and an API-key
fallback. OpenRouter and Tinfoil each have a dedicated connection screen after
provider selection, sharing Google's Connect / Connected / Disconnect button.
Users click Continue after connecting; there is no model-summary screen. The app
matches the shipped Thunderbolt default against the provider catalog and tests
it before saving, without asking the user to choose a model. Disconnect removes
device-local credentials and makes that provider's models unavailable while retaining their
identities and chat history. Other providers and local models remain available through manual setup;
custom OpenAI-compatible endpoints start blank, with an Ollama URL shown only as a placeholder. No endpoint is contacted until the user enters one. A server URL alone does not count as a usable account:
local users who skip sign-in can finish onboarding and connect their own model later before using an agent.

OpenRouter's desktop callback uses the native loopback listener. Provider flows
release cancelled listeners using a per-flow nonce, so retries do not exhaust
the registered ports and late cleanup cannot stop a newer flow. Google, Microsoft,
SSO and MCP desktop flows also isolate callbacks by listener origin and path. The
native listener rejects unrelated methods, paths and Host/Origin headers, keeps
waiting for a valid callback, and checks cancellation while reading partial requests.
Its completion page clears callback credentials from browser history. Web authorization
returns to `/oauth/openrouter/:flowId` and relays through a nonce-scoped
`BroadcastChannel`, because the app's COOP headers sever a cross-origin popup's
opener. The PKCE verifier remains in memory, callback query parameters are cleared,
and analytics strip the callback nonce from URL properties.

Tinfoil uses OAuth 2.1 PKCE with the public Thunderbolt client ID (override with
`VITE_TINFOIL_CLIENT_ID`). Authorization and paid subscription checkout run at
`https://dash.tinfoil.sh/oauth/authorize`; token exchange, refresh and revocation
call `https://api.tinfoil.sh/oauth/{token,revoke}` directly. No backend or client
secret is required. The registered redirects must include desktop loopbacks
`http://localhost:17421/`, `:17422/`, `:17423/` and each web deployment's
`/oauth/tinfoil` URL. Web callbacks use the random state to address the same-origin
BroadcastChannel. Native mobile currently uses BYOK; the public-client mobile
redirect registration and deep-link flow still need to be confirmed with Tinfoil.

Provider setup captures a local connection revision before authorization or model
verification and checks it again inside the model-save transaction. Disconnecting,
toggling, or replacing a connection advances that revision, so an older attempt in
another window cannot restore access. Revisions remain in `integrations_secrets`;
OpenRouter's row contains only this lifecycle metadata, while its API keys stay in
`models_secrets`. Tinfoil token refresh preserves the revision. Cancellation also
aborts pending network work and rolls back saves that have not committed.

OAuth sessions live in the existing local-only `integrations_secrets` table;
`models_secrets.oauth_provider` links a user model to that session. Neither tokens
nor the link sync to other devices. Refresh, reconnect persistence, enable/disable and disconnect
share a Web Lock; refresh re-reads credentials inside the lock and persists rotated
refresh tokens before releasing it. A rejected grant requires reconnecting; it
never falls back to Mozilla billing. Each encrypted inference request resolves a
fresh token, including requests within long agent turns. BYOK and backend-managed
models retain their existing paths. Settings → Connections offers enable/disable
and reconnect/disconnect controls. Billing remains on Tinfoil's dashboard. Disconnecting access does
not cancel the subscription. Disabling or disconnecting the subscription does not
change individual model toggles: availability is derived from both the model
preference and current connection access. A failed remote revocation keeps the
local connection intact so disconnect can be retried.

Open chats watch model and connection changes from the database, including other
windows. Every new send independently checks availability again. These checks do
not recall requests already sent: an already-running BYOK agent turn can finish
using its prepared provider, while subsequent turns use the updated selection.

Automatic provider setup marks its model in the local-only
`models_secrets.provider_default` column. Reconnecting reuses that provider/model
and credential-kind row, restoring credentials without changing individual model
preferences or overwriting manually added models. Clearing credentials preserves
the marker. Existing Tinfoil OAuth rows also qualify for reuse; older OpenRouter
and BYOK rows cannot be distinguished from manual entries, so their first
reconnection after this change can create one new marked default. Local-only
schema changes are applied by PowerSync and require no server migration.

Protocol references: [draft integration](https://github.com/tanyav2/thunderbolt/pull/1)
and [authorization server metadata](https://api.tinfoil.sh/.well-known/oauth-authorization-server).
Tinfoil's token endpoint also permits browser CORS; deployment redirects still
need to be registered for the public client. The separate verification-center UI
from PR 2 is not imported; inference retains the app's existing attestation path.

Without a server, backend-managed model entries are unavailable. Native builds
include the HTTP transport by default and use it directly in standalone mode,
regardless of a stale proxy preference. The main app window's HTTP(S) permission
allows the endpoints users configure. Web tools fetch page contents through their configured provider, not arbitrary device-side requests. Remote
webviews do not gain that permission. The packaged app also grants no IPC
capabilities to remote localhost pages; Tauri automatically treats the configured
`devUrl` as local during development, so no production localhost exception is
needed. Browser-only standalone installs remain subject to the provider's CORS policy.

Search selects a reusable provider connection by ID. Connection metadata syncs; its
credentials live only in the device-local `provider_connection_secrets` table. Search
selection contains no keys. Existing Brave configurations remain compatible. Exa and Tavily retrieve page text through
`/contents` and `/extract` respectively; Brave exposes search only. There is no
arbitrary device-side page downloader. Extraction responses are capped at 1 MiB
before JSON parsing, with a 30-second deadline covering headers and body reads.
Search results and extracted pages enter
the normal citation/source collector and tool budget. Standalone link previews
use collected source metadata or a hostname fallback without an unsolicited page
request.

New Tinfoil sources also persist a passive-image restriction in their citation
metadata. Citation cards and previews show local placeholders instead of fetching
site favicons or thumbnails directly, which would expose the device's IP outside
the encrypted search transport. Explicitly opening a source still navigates to
the website. The recorded policy also survives URL-only preview markup and later
provider changes. Protection continues through later replies in the conversation,
including replies with no new search; remote Markdown images become explicit
links. Each turn keeps its own citation indices rather than inheriting source rows.
Local attachment paths remain usable. This restriction covers citation and preview
media, not every widget: maps still contact their map tile provider. Older source
records without this marker retain their prior behavior.

An explicitly selected connection never falls back to another connection or to
Thunderbolt Cloud when disabled, disconnected, or unavailable. Cloud remains the
default when no local connection was selected. Every web-tool call checks both the
current selection and the connection's authorization generation. A turn rejects
calls after a switch or credential replacement; ordinary OAuth refresh retains
that generation and the turn's citation registry.

Tinfoil OAuth and API-key connections supply search independently of models.
Onboarding selects Tinfoil search automatically after connecting; Otari is selected
only after its gateway advertises direct search. Unavailable Otari search shows an
explanation and keeps the optional search step. Existing named search connections
can be reused without re-entering credentials. Each Tinfoil search or page
retrieval opens and closes a short-lived MCP transport using the existing OAuth
session or API key. On desktop, the attestation SDK verifies the enclave key and
the public `ehbp` primitives encrypt/decrypt envelopes over native HTTP;
plaintext result payloads are rejected. The optional GET event stream is disabled
because a bodyless request cannot establish EHBP response keys. Tool results use
encrypted POST responses, including streamed responses; only empty notification
acknowledgments and payload-free session termination can bypass decryption. This
avoids global-fetch overrides and the MCP endpoint's browser fetch-metadata restriction.

Browsers send those encrypted envelopes through the fixed same-origin
`/_tinfoil/search` relay (Vite dev/preview and the deployed frontend nginx
template). It forwards only to `https://websearch.tinfoil.sh/mcp`, verifies upstream
TLS, strips browser cookies/origin metadata, disables caching and streams
responses. It sees the provider authorization header and traffic metadata, but
cannot decrypt search queries or results. No Thunderbolt account or backend is
required. Static-only hosts must provide this relay; desktop connects directly.
PII and prompt-injection filtering are enabled. Results are sent to the selected
model provider. No model-side `web_search_options` are injected.

Settings → Search lists named, search-capable connections and links to Connections
to add or edit credentials. Multiple Exa, Brave, Tavily, Tinfoil, and Otari API-key
connections can coexist. Selecting one never replaces another connection's key.
Models reference the same connections, but enabling or removing an individual
model does not change search access.

### Migrating provider credentials

The migration creates one stable `legacy-model:<model-id>` connection per legacy
API-key model. It deliberately does not deduplicate by key: two devices can have
different local keys for the same models, so grouping on one device would silently
change another device's account mapping. Newly added models reuse an explicit
connection. Tinfoil OAuth retains its single `oauth:tinfoil` connection.

A device migrates its local key even if another device has already synced the
model's connection reference. The legacy model URL is retained for this handoff:
it is the routing identity that this device approved for that key. Existing local
credentials and disconnect tombstones win over retries. A synced provider, auth
method, or URL mismatch is never granted the legacy key; the old key remains local
for recovery. If devices used different authentication methods for the same model,
the migration preserves the local key or OAuth reference for an explicit reconnect
without overwriting the synced connection. An API key cannot claim an `oauth:` ID,
even when that model reference arrives before the connection metadata. Model IDs,
profiles, enabled flags, and chat history are retained.

Legacy standalone search keys move from `thunderbolt-search-provider` into stable
`legacy-search:<provider>` connections before the old storage entry is removed.
The ID-only selection lives under `thunderbolt-search-selection`. An interrupted
migration can retry without duplicating connections or restoring a disconnected
credential, and explicit None/Cloud or a newer selection remains intact.

### Otari

Otari connects through a registered public OAuth client with S256 PKCE. The
official server is the default; Custom URL supports another HTTPS deployment or
HTTP loopback for local development. Browser authorization redirects in the same
tab. Desktop uses the existing native loopback listener, while native mobile
uses the same verified HTTPS app link as Google and Microsoft. Pending mobile
authorization survives an app restart. None of these flows requires a
Thunderbolt backend.

The Otari deployment must register the `thunderbolt` client, the web deployment's
`/oauth/otari` redirect, desktop `http://localhost/` loopback redirect, and mobile
`https://app.thunderbolt.io/oauth/callback` redirect. Browser deployments also
need their origin in Otari's CORS configuration. The app uses Otari's standard
`/api/v1/oauth/apps/authorize` and `/api/v1/oauth/apps/token` endpoints.

After workspace approval, the user chooses a searchable catalog model and
Thunderbolt verifies its tool support before saving it. The model keeps the
first-class `otari` provider identity and the catalog's display name, with a
generic readable fallback when the server supplies only an identifier. The
opaque delegated key stays in the existing device-local model secret store.
Reconnecting the same model on the same server preserves its identity and user
preferences; manually configured models and other servers stay separate.
Connections controls only the models created by this connection flow.

Otari model, catalog, search, and page-fetch requests go directly to the chosen
server, without cookies or redirect following. Otari supplies ordinary HTTPS
transport, not Tinfoil's encrypted enclave transport. Search is selected and its
onboarding step skipped only when the workspace advertises available search.
Otherwise setup explains the missing capability and keeps the search step.
Refresh Models rechecks workspace capabilities; each search turn also rechecks
the selected server before exposing its search and page-fetch tools. Missing or
disconnected Otari access never silently changes an explicitly selected search
provider. Remote result images remain links, as with other local search providers.

### Provider connection research

The following provider contracts were checked on October 23, 2026. These are
integration capabilities, not a claim that every flow is implemented here.

- **OpenRouter:** its [OAuth PKCE flow](https://openrouter.ai/docs/guides/overview/auth/oauth)
  exchanges browser consent for a user-owned API key without an app client secret.
  Use S256 and validate state. Desktop loopback callbacks on arbitrary localhost
  ports are documented; custom app URI callbacks are not. After connection, the
  app requests [`/api/v1/models/user`](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails)
  so its catalog respects account preferences, privacy settings, and guardrails.
  The [web plugin](https://openrouter.ai/docs/guides/features/plugins/web-search)
  and [web-search server tool](https://openrouter.ai/docs/guides/features/server-tools/web-search)
  add search to model requests using the same account. They do not document a
  standalone search-results endpoint; the server tool is beta and search adds
  usage charges.
- **Tinfoil:** [API-key setup](https://docs.tinfoil.sh/get-api-key) was the public
  connection contract at the research date. The later first-party OAuth
  integration described above supplies the subscription connection; this older
  research result is not a limitation of the implemented flow. Inference stays on the attested
  [Tinfoil SDK transport](https://docs.tinfoil.sh/sdk/javascript-sdk), including
  browser-compatible EHBP. [Plain HTTPS access](https://docs.tinfoil.sh/sdk/direct-api-access)
  skips attestation and is discouraged for production. Tinfoil also supplies
  [model-integrated search](https://docs.tinfoil.sh/guides/web-search) and a
  [search/fetch MCP server](https://docs.tinfoil.sh/guides/mcp-websearch) using the
  Tinfoil API key.
- **Exa:** [MCP OAuth](https://exa.ai/docs/get-started/exa-mcp#authentication)
  is documented for interactive clients and production at
  `https://mcp.exa.ai/mcp?login`, with usage billed to the user's Exa team.
  Its [authorization metadata](https://auth.exa.ai/.well-known/oauth-authorization-server)
  advertises S256 PKCE, public clients, dynamic registration, refresh tokens,
  and the `mcp:tools` scope. This authorizes MCP access; do not assume the token
  works with the REST search endpoint. An API key is the documented fallback.
  Native callback compatibility still needs an end-to-end integration check.

### No-key search research

Checked November 4, 2026. A future option should distinguish **no API key** from
**local**: a remote search service still receives the query, even when called
directly from the device. Fully offline search requires a previously downloaded
index. No additional search provider is enabled by this research.

- DuckDuckGo's [HTML/Lite interfaces](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript)
  are web interfaces, not a supported general-search API. Embedding a scraper
  would introduce CAPTCHA handling and maintenance; it is not a dependable default.
- [Mwmbl](https://developer.mwmbl.org/) advertises an anonymous API tier. It is a
  promising no-key candidate, but its [terms](https://developer.mwmbl.org/terms/)
  need clarification on commercial use and registration, and its result quality
  and freshness need evaluation before inclusion.
- [SearXNG's search API](https://docs.searxng.org/dev/search_api.html) is suitable
  for an optional user-configured instance. Public instances may disable JSON
  access, and hosting an instance does not meet zero-setup onboarding.
- [Jina Reader](https://jina.ai/reader/) offers keyless page extraction, but it is
  another remote service; its search API requires a key. It would not provide a
  single local or keyless search-and-extraction option.

## Cloud features, analytics, and backups

Sign-in, cloud proxy, and sync controls remain visible and offer server setup
first. Sync still requires account authentication and the encryption setup flow.
Google/Microsoft connections and hosted services require a server. Hosted voice
also asks for server sign-in before opening the microphone; a configured custom
voice provider can run independently. Local
export/import/reset remain available without an account. Location can be entered
manually without using the server's geocoder.

Standalone analytics use Thunderbolt's normal PostHog endpoint at
`https://api.thunderbolt.io/v1/posthog`, including its public configuration
endpoint. Existing analytics consent and event sanitization remain in force;
the final onboarding screen offers an optional usage-data donation
toggle backed by the same `data_collection` setting as Preferences. The default
is enabled; an existing opt-out is preserved. Changes are saved before setup can
finish, and a failed save offers a retry rather than discarding the user's choice.
Analytics are device-pseudonymous, not strictly anonymous: the SDK keeps a random
installation ID, session metadata, and timestamps. Sign-in never identifies or
aliases an account, person profiles are disabled, and events omit account IDs,
synced row IDs, debug trace IDs, account-derived hashes, custom model names, and
raw error text. A dedicated persistence namespace starts a new device identity
for existing installs without changing their consent; previously collected data
is not retroactively removed. Analytics failure cannot block startup. Search
credentials are cleared by the existing local reset flow.

The donation toggle controls app analytics. Backend inference analytics currently
remain enabled independently when the server configures PostHog; account-link
removal applies there too. This exception is retained deliberately for now.
Billing records and operational logs are separate from both analytics paths.

Serverless does not imply every feature works without internet. Fully offline
chat needs an already downloaded local model. Hosted models, search, integrations,
analytics, and update checks need network access. Without sync, local exports are
the recovery path if the device is lost or its data is cleared.

### macOS development signing

Repeated unsigned rebuilds can trigger repeated prompts for the app's “WebCrypto
Master Key.” The login keychain identifies an ad-hoc build by its binary hash;
that hash changes when the application is rebuilt. Use a stable development
signing certificate for repeated local builds, and keep the app's bundle ID stable.
A local self-signed code-signing identity is sufficient for keychain identity
tracking; it is not a release or notarization identity. See Apple's
[code-signing identity guidance](https://developer.apple.com/library/archive/technotes/tn2206/_index.html).

Do not delete the WebCrypto master key to suppress a prompt: existing persisted
CryptoKeys may depend on it. Signing an updated app can still require a one-time
user approval to access the key created by the previous unsigned build.
