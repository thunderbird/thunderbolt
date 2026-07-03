# Spec: Standalone mode & unified onboarding

**Status:** Decisions captured via interview. Three items from the final round are
best-judgment defaults pending a nod (marked **[default]**); everything else is confirmed.
**Relationship:** Consumes the **Provider primitive** (`spec.md`). This is `spec.md` §10 +
appendix, promoted to its own spec. Build the provider primitive first (or together).
**Replaces:** the current `ModePicker` (`src/components/boot/mode-picker.tsx`) and the
`STANDALONE_NOT_SUPPORTED` hard-fail in `use-app-initialization.ts`.

---

## 1. Goal

A user downloads Thunderbolt (desktop) and, on first boot, chooses:

- **Log in to enterprise / private-beta account** — email → discovery → connect to the
  right server → today's normal server-mode onboarding.
- **Set up my own model + search provider (advanced)** — fully local **standalone** mode
  powered by the **built-in Thunderbolt agent** ("on-device agent"): connect a model
  provider, then a search provider, then the normal onboarding screens — one coherent
  full-screen flow.

**The "on-device agent" IS the built-in Thunderbolt agent.** There is no separate
on-device-agent concept: providing no email → you run the built-in agent locally, powered
by your own connected provider keys (OpenRouter / Tinfoil / Ollama / custom). Providing an
email → server login.

Server-backed deployments (a configured `VITE_THUNDERBOLT_CLOUD_URL`) skip the provider
steps and go straight to login → normal onboarding.

---

## 2. Confirmed decisions

- **Platform:** Desktop (Tauri) **only** at launch (TS-layer code kept web-portable where
  cheap — see free search).
- **Data layer:** reuse the existing PowerSync **local** SQLite DB + DAL (incl. the new
  `providersTable`/`providersSecretsTable` + `modelsTable.providerId`), **never connected
  to a sync backend**; **E2E encryption off** in standalone (device-local). One code path.
- **Identity:** standalone = **no account, fully local** (uses the already-minted
  `localUserId`).
- **Integrations:** **kept in standalone.** Verified: only token exchange + refresh touch
  the backend (confidential client / client secret); every Gmail/Calendar/Graph API call is
  client-side, direct to Google/Microsoft, using the locally-stored token
  (`src/integrations/google/tools.ts`, `microsoft/tools.ts`; tokens in
  `integrationsSecretsTable`). So integrations work with **no Thunderbolt account** as long
  as the **public server hosts `/auth/{google,microsoft}/{config,exchange,refresh}`**. The
  onboarding integrations step is kept, pointed at the public server.
- **Proxy:** desktop routes inference/search through the **Tauri backend**; a **public
  `/v1/proxy`** endpoint backs the free tier, web CORS, and discovery.
- **Email→server:** central **discovery service** on the public server → `activateServer()`.
- **Login path:** discovery → existing `activateServer({serverId, cloudUrl})`; **no new
  boot path** — collapses into today's server mode + normal onboarding.
- **Onboarding:** full-screen **step-router rewrite** of `onboarding-dialog.tsx`.
- **Free model:** route through public `/v1/proxy` on our key, **per-device rate-limited**.
- **Free search:** **keyless DuckDuckGo HTML scrape in the TS layer** (not Rust) so it can
  serve web + desktop; desktop fetches directly, **web goes through `/v1/proxy` for CORS**
  (`html.duckduckgo.com` sends no CORS headers).
- **Test gate:** **HARD** — cannot advance a provider step until the test message / test
  search actually succeeds. **Skip** is the explicit escape hatch.
- **Skip behavior:** warn, enter the app, show a **persistent "connect a provider" prompt**
  (banner/empty-state) pointing at Settings › Providers.
- **Default provider order:** **OpenRouter first** (lowest-friction OAuth), then Tinfoil,
  Anthropic, OpenAI, Ollama, Custom.
- **On-device agent:** = the **built-in Thunderbolt agent**. The BYO-provider standalone
  flow (no email) IS the on-device-agent flow; Ollama/localhost is just one of the model
  providers it can use, not the definition. No separate on-device-agent concept.
- **Provider count in onboarding:** exactly **one model + one search** provider (matches
  `spec.md` v1 "one connection per type"); add more later in Settings › Providers.

---

## 3. Provider auth matrix (corrected via research, 2026)

Supersedes `spec.md` §4's Anthropic row.

| Provider    | Capability      | Connection      | Notes |
|-------------|-----------------|-----------------|-------|
| OpenRouter  | models          | **oauth-pkce**  | `openrouter.ai/auth?callback_url&code_challenge&code_challenge_method=S256` → `POST openrouter.ai/api/v1/auth/keys {code, code_verifier}` → user API key. No client secret → standalone-safe. Loopback redirect on desktop. |
| Anthropic   | models          | **api-key**     | ⚠️ NOT oauth-paste. Claude Code's OAuth is client-locked + ToS-prohibited for third parties. Console API key only (`x-api-key`). |
| OpenAI      | models          | **api-key**     | "Sign in with ChatGPT" is Codex-only, not a third-party API grant. Bearer key only. |
| Tinfoil     | models + search | **api-key**     | No OAuth exists. Bearer key via their SDK (HPKE/attestation). Full Tinfoil wiring still deferred per `spec.md`; when it lands it's api-key. |
| Ollama      | models          | **url** (+key)  | Local default `http://localhost:11434` (no auth). Cloud: `https://ollama.com`, Bearer key. This is the "on-device agent" path. |
| Custom      | models          | **url** + key   | OpenAI-compatible base URL, optional key. |
| Exa         | search          | **api-key**     | `x-api-key`, `POST api.exa.ai/search`. |
| Brave       | search          | **api-key**     | `X-Subscription-Token`, `GET api.search.brave.com/res/v1/web/search`. |
| SerpAPI     | search          | **api-key**     | `api_key` query param, `serpapi.com/search.json`. |
| SearXNG     | search          | **url**         | User base URL; `{base}/search?format=json`. ⚠️ JSON output must be enabled by the operator — surface a clear error if the URL returns HTML. |
| DuckDuckGo  | search (free)   | **none**        | Keyless HTML scrape (`html.duckduckgo.com/html/`), TS layer. Unofficial, fragile, ~30/min. |

**Recommendation:** drop the `oauth-paste` connection type from the catalog for v1 — no
provider uses it. Re-add if a future provider needs it.

---

## 4. Boot flow changes

`resolve-boot-trust-domain.ts` / `use-app-initialization.ts`:
1. **Remove** the `STANDALONE_NOT_SUPPORTED` fail; standalone becomes a first-class
   resolution booting into the local (unsynced) DB + `localUserId`.
2. **Replace `ModePicker`** with the new full-screen **entry screen** (§5) on
   `no-trust-domain`.
3. Standalone resolution: init local DB **without** `.connect()`, no post-auth server
   bootstrap, `cloudUrl` unset (or pointed only at the public proxy for free-tier/discovery).
4. Returning standalone boots skip the entry screen (persisted `activeTrustDomain =
   {kind:'standalone'}`) → chat, or resume onboarding if incomplete.

## 5. Entry screen (replaces ModePicker)

Full-screen, two actions:
- **Log in** → email → `POST {publicServer}/discovery` → `{ serverUrl }` →
  `activateServer(...)` → reload into server mode.
- **Set up my own providers (advanced)** → standalone → provider steps (§7–8) → shared
  onboarding (§11).

No more disabled "on-device agent" card.

## 6. Standalone data layer

Same schema + DAL as server mode; PowerSync local SQLite runs offline. **E2E encryption
off** — verify interaction with the `isEncrypted`/`isConfidential` thread coupling
(`chat-instance.ts:382`): confidential (Tinfoil) models must not force an encryption path
that assumes a key hierarchy absent locally. Provider secrets in local-only
`providersSecretsTable`, unchanged from server mode.

## 7. Model-provider onboarding step

- Dropdown ordered **OpenRouter, Tinfoil, Anthropic, OpenAI, Ollama, Custom**.
- Branch by `connectionType` (§3): OAuth button (OpenRouter), API-key input, URL+key.
- On connect: persist `providersTable` row + secret; auto-select default model (§9); run
  **test message (hard gate)**.
- **"Try a free model"** below the selector → free-tier route (§8), lets the user proceed
  with zero config.
- **Skippable** → warn + persistent nag.

## 8. Search-provider onboarding step

- Auto-skipped if a connected provider already supplies `search` (e.g. Tinfoil).
- Dropdown: Exa, Brave, SerpAPI (api-key), SearXNG (url), **"Free local search via
  DuckDuckGo."**
- **Test search (hard gate)** before continue. **Skippable** → warn + persistent nag.
- Sets `search_provider_id` (`spec.md` §7).

### Free-tier mechanics
- **Free model:** `/v1/proxy` on the public server holds our OpenRouter/hosted key;
  per-device daily rate limit; strip identifiers.
- **Free search:** DDG HTML scrape in a **TS module** shared by web + desktop; desktop
  fetches directly, web injects `/v1/proxy` for CORS. Fail gracefully (fragile/rate-limited).

## 9. Default-model selection

Per-provider curated preference list → 1-token test message → first that passes →
`selected_model`. Fallback to first listed model.

## 10. Email → server discovery

`POST {publicServer}/discovery { email }` → `{ serverUrl }`. Client validates like
`mode-picker.tsx`'s `validateServerUrl` (GET `/v1/config`, check `serverId`) then
`activateServer()`. Return a uniform response regardless of match (privacy; mirrors the
waitlist flow) so it doesn't leak which emails map to which servers.

## 11. Unified full-screen onboarding

Rewrite `onboarding-dialog.tsx` (modal) into a full-screen **step-router**:
- **Standalone:** entry → model provider → search provider → privacy → **integrations
  (Google/Microsoft via public-server OAuth proxy)** → name → location → celebration.
- **Server:** login → privacy → auth/integrations → name → location → celebration. Provider
  steps skipped.

Both modes now share the integrations step; only the provider/login steps differ.

Preserve per-step persistence (`onboarding_current_step`, `user_has_completed_onboarding`)
and the returning-user bypass.

## 12. Public server responsibilities

- Rate-limited unauthenticated slice of `/v1/proxy` for the free tier + web-CORS DDG.
- `/discovery` email→server endpoint.
- Free-tier key custody + per-device rate limiting.
- **OAuth confidential-client proxy** `/auth/{google,microsoft}/{config,exchange,refresh}`
  (holds `GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_*`) so standalone integrations work without a
  Thunderbolt account.

## 13. Delivery / phasing

1. Provider primitive (`spec.md`, two-PR PowerSync flow).
2. Standalone boot + local-unsynced data layer + entry screen.
3. Provider/search onboarding steps + hard-gate tests + default-model selection.
4. Free model + free search (shared TS module).
5. Onboarding full-screen rewrite.
6. Email→server discovery + public-server free tier.

Standalone adds **no new synced tables**, so it isn't itself gated by the two-PR flow —
but depends on the primitive's tables existing.

## 14. Risks / couplings

- E2E-off vs `isEncrypted`/`isConfidential` thread coupling (`chat-instance.ts:382`).
- DDG scraping unofficial/fragile — best-effort, graceful failure, web needs CORS proxy.
- SearXNG JSON-disabled-by-default — explicit error handling.
- OpenRouter desktop redirect: loopback vs custom scheme — reuse `use-oauth-connect.ts` /
  `oauth-loopback.ts`.

## 15. Remaining to confirm

Nothing open — all interview decisions are locked. Integrations-in-standalone was verified
against the code (§2). Next step is turning §13 into a task breakdown, and deciding whether
this ships as a companion to `spec.md` or merged into it.
