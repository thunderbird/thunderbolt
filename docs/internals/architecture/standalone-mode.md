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
device-local keys and disables that provider's models while retaining their
identities and chat history. Other providers and local models remain available through manual setup;
custom OpenAI-compatible endpoints default to Ollama at
`http://localhost:11434/v1`. A server URL alone does not count as a usable account:
local users who skip sign-in can finish onboarding and connect their own model later before using an agent.

OpenRouter's desktop callback uses the native loopback listener. Web authorization
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

OAuth sessions live in the existing local-only `integrations_secrets` table;
`models_secrets.oauth_provider` links a user model to that session. Neither tokens
nor the link sync to other devices. Refresh, reconnect persistence, enable/disable and disconnect
share a Web Lock; refresh re-reads credentials inside the lock and persists rotated
refresh tokens before releasing it. A rejected grant requires reconnecting; it
never falls back to Mozilla billing. Each encrypted inference request resolves a
fresh token, including requests within long agent turns. BYOK and backend-managed
models retain their existing paths. Settings → Connections offers enable/disable
and reconnect/disconnect controls, with a subscription-management link in the
provider detail. Billing remains on Tinfoil's dashboard. Disconnecting access does
not cancel the subscription.

Protocol references: [draft integration](https://github.com/tanyav2/thunderbolt/pull/1)
and [authorization server metadata](https://api.tinfoil.sh/.well-known/oauth-authorization-server).
Tinfoil's token endpoint also permits browser CORS; deployment redirects still
need to be registered for the public client. The separate verification-center UI
from PR 2 is not imported; inference retains the app's existing attestation path.

Without a server, backend-managed model entries are unavailable. Native builds
include the HTTP transport by default and use it directly in standalone mode,
regardless of a stale proxy preference. The main app window's HTTP(S) permission
allows the endpoints users configure and the pages web tools fetch. Remote
webviews do not gain that permission. Browser-only standalone installs remain
subject to the provider's CORS policy.

The optional search key is device-local and excluded from synced settings. Existing Brave configurations remain compatible.
Search, page text extraction, citations, and link previews run through the local
provider transport. Page extraction supports HTML and text; binary documents are
not handled by this web-fetch path. A missing search provider leaves web tools
unavailable except for Tinfoil. An enabled user Tinfoil connection omits the search step in both directions and resumes normal profile onboarding. By default, existing Exa/Brave/Tavily settings take precedence; otherwise Tinfoil supplies the same `search` and `fetch_content` agent tools through its attested websearch enclave. Each tool call opens and closes a short-lived MCP transport using the existing OAuth session or API key. On desktop, the attestation SDK verifies the enclave key and the public `ehbp` primitives encrypt/decrypt envelopes over native HTTP; successful plaintext responses are rejected. This avoids global-fetch overrides and the MCP endpoint’s browser fetch-metadata restriction. Browsers send the same encrypted envelopes through the fixed same-origin `/_tinfoil/search` relay (Vite dev/preview and the deployed frontend nginx template). The relay forwards only to `https://websearch.tinfoil.sh/mcp`, verifies upstream TLS, strips browser cookies/origin metadata, disables caching and streams responses. It sees the provider authorization header and traffic metadata, but cannot decrypt search queries or results. It does not require a Thunderbolt account or backend. Static-only hosts must provide this same relay route; desktop continues to connect directly. PII and prompt-injection filtering are enabled. Results enter the normal source collector, activity UI, and web-tool budget, and are sent to the selected model provider. No model-side `web_search_options` are injected. Search has its own Settings page after Models, with the same list/detail layout. It displays the effective provider, including automatic Tinfoil access. Selecting a provider or disabling search is persisted device-locally; choosing Tinfoil preserves any separately saved search key. Explicit choices do not silently fall back if unavailable. Configure, replace, or disconnect a separate search provider in Settings → Search.

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
- **Tinfoil:** the public connection contract is [API-key setup](https://docs.tinfoil.sh/get-api-key);
  no public third-party OAuth flow was found. Keep inference on the attested
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
analytics failure cannot block startup. Search credentials are cleared by the
existing local reset flow.

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
