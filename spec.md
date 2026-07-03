# Spec: Provider primitive

**Status:** Design agreed, ready to build
**Scope:** Server mode first (the normal backed app). Standalone consumes it later.
**Ships as:** two new tables + one column, no E2E-encryption work.

---

## 1. Motivation

Today every model/search call is mediated by the Thunderbolt backend with provider
API keys held as **server-side env vars** (`ANTHROPIC_API_KEY`, `EXA_API_KEY`, …).
There is no way for a user to bring their own provider account, and no concept that a
single infra company (Tinfoil) can supply *more than one* capability.

We introduce a **Provider primitive**: a connected account at an infra company
(OpenRouter, Exa, Tinfoil, Anthropic, …) that advertises one or more **capabilities**
(`models`, `search`, and future ones). Most providers offer one capability; Tinfoil
offers both. The thesis: as infra companies start offering multiple things, a user
should connect **one account** and get all of its capabilities.

This is the first step toward standalone mode (see §10), but it ships into the normal
server app first, alongside the existing system models.

---

## 2. The primitive

Three layers, mirroring the codebase's established "synced metadata + local-only
secret" pattern (`modelsTable`+`modelsSecretsTable`, `mcpServersTable`+`mcpSecretsTable`,
`agentsTable`+`agentsSecretsTable`).

### 2.1 Provider catalog — code, not a table

Static metadata per provider *type*. Ships with the app (like `model-selector.tsx`'s
`needsApiKey()` already branching on provider type). Lives in `shared/providers.ts`:

```ts
type ProviderCapability = 'models' | 'search' // extensible: 'embeddings', 'tts', …
type ConnectionType = 'oauth-pkce' | 'oauth-paste' | 'api-key' | 'url'

type ProviderDefinition = {
  type: 'openrouter' | 'tinfoil' | 'exa' | 'anthropic' | 'openai'
      | 'ollama' | 'brave' | 'serpapi' | 'searxng' | 'custom'
  name: string
  capabilities: ProviderCapability[] // what it CAN do — tinfoil: ['models','search']
  connectionType: ConnectionType
  defaultBaseUrl?: string            // ollama → http://localhost:11434, etc.
}
```

`capabilities` being a set is where the "one company, many capabilities" thesis lives.

### 2.2 Provider connection — the user's connected account (two tables)

**`providersTable`** (synced via PowerSync — metadata only, no secret):

```ts
export const providersTable = sqliteTable(
  'providers',
  {
    id: text('id').primaryKey(),                    // UUID (see §6)
    type: text('type').notNull(),                   // catalog key
    label: text('label'),                           // account email / nickname
    baseUrl: text('base_url'),                       // override for url-type providers
    enabledCapabilities: text('enabled_capabilities', { mode: 'json' })
      .$type<ProviderCapability[]>(),               // subset of catalog caps user turned ON
    enabled: integer('enabled').default(1),
    deletedAt: text('deleted_at'),
    defaultHash: text('default_hash'),
    userId: text('user_id'),
    workspaceId: text('workspace_id'),
    scope: text('scope', { enum: ['workspace', 'user'] }).default('workspace'),
  },
  (table) => [
    index('idx_providers_active').on(table.id).where(sql`${table.deletedAt} IS NULL`),
    index('idx_providers_workspace_id').on(table.workspaceId),
  ],
)
```

**`providersSecretsTable`** (local-only — never synced, mirrors `modelsSecretsTable`):

```ts
/** Local-only table for provider credentials. Never synced via PowerSync. */
export const providersSecretsTable = sqliteTable('providers_secrets', {
  providerId: text('id').primaryKey(),
  credentials: text('credentials'), // JSON: { apiKey } | { access_token, refresh_token, expires_at }
})
```

DAL mirrors `src/dal/integrations.ts` (SELECT-then-INSERT/UPDATE because PowerSync
local-only tables are views without UPSERT).

**Consequence (consistent with custom models today):** because the secret is local,
a synced provider shows as "connected" on device B but its key must be re-entered
there. This already matches custom-model behavior, so it's not a new wrinkle.

### 2.3 Models reference a provider

Add a nullable column to `modelsTable`:

```ts
providerId: text('provider_id'), // FK → providers.id; null for system/backend models
```

- System/backend models (`isSystem=1`, server-injected key) keep working unchanged —
  `providerId` stays null, key still comes from the backend. **No forced migration.**
- User-connected models resolve their key from the provider's secret (via `providerId`)
  instead of `modelsSecretsTable`. `modelsSecretsTable` stays for legacy/custom rows and
  is deprecated over time.
- The existing `provider` enum column is derivable from the connection's `type`; keep it
  for back-compat, set it on new rows from the catalog.

---

## 3. Models: catalog vs. curated rows

Providers can expose **thousands** of models. We must not materialize them all as rows
(that would flood the synced `modelsTable` and wreck sync). Two layers:

- **Catalog (live, not stored):** the provider's full `/models` list, fetched on demand
  via React Query when the provider's settings open, cached in memory, always fresh. No
  table. (If load time ever bites, add a local-only cache table à la `agentsSystemTable`
  with `fetchedAt` — **not in v1**.)
- **Curated rows (`modelsTable`):** only models the user toggled on. A row exists ⟺ the
  model is in the chat selector. These sync across devices, carry per-model config
  (profiles, names, prompts), and feed the existing selector unchanged.

**The toggle is the bridge:** flip a catalog model **on** → upsert a `modelsTable` row
(`providerId`, `model` id, `name`, `enabled=1`); flip it **off** → soft-delete the row.
The chat selector keeps its current behavior (`enabled=1`, not deleted). The existing
`enabled` column remains a secondary quick show/hide on the Models page without losing
per-model config.

---

## 4. Connection methods (all four in v1)

Driven by the catalog's `connectionType`. Reuses `src/hooks/use-oauth-connect.ts`
(loopback / redirect / mobile deep-link plumbing) where applicable.

| Method        | Providers                         | Notes |
|---------------|-----------------------------------|-------|
| `api-key`     | OpenAI, Exa, Brave, SerpAPI       | Plain key input. Lowest effort. |
| `oauth-pkce`  | OpenRouter                        | Browser OAuth, no client secret → standalone-safe. |
| `oauth-paste` | Anthropic                         | Open provider auth page, user pastes returned code/token (CLI pattern). No backend secret. |
| `url` (+ key) | Ollama, SearXNG, Custom           | Base URL (Ollama localhost default), optional key. |

> Tinfoil connect (`oauth-backend`-style brokered by the backend) is **deferred** — its
> capabilities (`models`+`search`) and HPKE proxy need separate design. The catalog entry
> can exist with a "coming soon" state.

### 4.1 Validation / test connection

Each capability defines a validation strategy in the catalog (replaces "no test exists
today"):
- `models` → list `/models`, then a 1-token completion against the chosen default.
- `search` → one query against the provider.

Surface success/failure inline on connect.

---

## 5. Inference & search routing (server mode)

User-provided keys live **client-side** (local secret). They reach providers via the
existing **universal proxy** at `/v1/proxy` (`backend/src/proxy/routes.ts`):

- Client calls the provider **through** `/v1/proxy`, passing the target URL in the
  target-URL header and **its own provider key in a `passthrough`-prefixed header**
  (`shared/proxy-protocol.ts`).
- Backend forwards the request and the passthrough headers upstream **without storing the
  key**. This avoids browser CORS (browser → our backend → provider) and keeps the
  backend stateless w.r.t. user keys.

So model rows with a `providerId` route through `/v1/proxy`; system models keep using
`/chat/completions`. Search with a user provider routes through `/v1/proxy` too; the
active search provider is a setting (§7).

---

## 6. Multiplicity

**UUID-keyed `providersTable` rows (schema supports multiple per type), v1 UI = one
connection per type.**

- UUID PK is the right choice for a synced, soft-deletable table anyway (no resurrecting
  a soft-deleted type-keyed row), so "multiple" costs nothing extra in the schema —
  `modelsTable.providerId` is a UUID FK either way.
- v1 UI shows one "Connect" button per type (→ "Connected" once done). Relaxing to allow
  multiple accounts later needs **no migration**, only UI.
- No use-time ambiguity: a model row carries its own `providerId`, so the selector
  doesn't care how many connections exist.

---

## 7. Search integration

Search becomes a setting `search_provider_id` → a `providersTable` row whose
`enabledCapabilities` includes `'search'`, chosen on the Providers page. Exactly one
active search provider (vs. many models). Replaces the hardcoded Exa-only path in
`backend/src/api/search.ts`; the backend Exa env-var path remains as the system default
when no user search provider is set.

---

## 8. Navigation / UX

```
Settings
├── Providers  (NEW)
│     • list of connected accounts, each with capability badges [Models] [Search]
│     • "Connect" buttons for not-yet-connected provider types
│     └── Provider detail  →  e.g. "OpenRouter"
│           • account label, connection status, disconnect
│           • capability toggles (Models / Search) when provider offers both (Tinfoil)
│           • Models catalog: searchable/filterable list of ALL provider models,
│             each with a "Show in chat" toggle  ← the thousands live here, behind search
│           • (for search-capable) "Set as active search provider"
│
└── Models  (EXISTING — becomes the curated view)
      • flat list of every enabled model across providers, grouped by provider
      • rename, per-model profile/config, enable/disable, set default
      • "+ Add models" deep-links into the relevant provider catalog
```

Mental model: **Providers = connect accounts & browse/enable models; Models = your
curated working set.** Follow route code-splitting rules in `CLAUDE.md` — both are
settings pages, so lazy-load them.

---

## 9. Delivery plan (two-PR PowerSync flow)

`providersTable` is synced, so it follows the mandatory two-PR process
(`docs/architecture/powersync-account-devices.md`). `providersSecretsTable` is local-only
→ no sync rule.

**PR 1 (backend-only):** backend Drizzle schema for `providers`, migration (+ verify
`_journal.json`), `shared/powersync-tables.ts`, `config.yaml` sync rule, `modelsTable`
`provider_id` column. Merge → run migration → update PowerSync Cloud dashboard rules.

**PR 2 (frontend + everything else):** `shared/providers.ts` catalog, frontend schema for
both tables, DAL, connection flows (the 4 methods), validation, catalog fetch +
toggle→row logic, `/v1/proxy` routing for BYO-key models, search-provider setting,
Providers + Models settings UI. Merge only after PR 1's dashboard rules are live.

---

## 10. Out of scope (future)

- **Tinfoil connect** + HPKE-proxy capability wiring (§4 note).
- **Standalone mode** boot (currently throws `STANDALONE_NOT_SUPPORTED` in
  `use-app-initialization.ts`). This primitive is its foundation; the standalone
  onboarding flow (below) consumes it.
- **Email→server discovery** (enterprise auto-routing) — does not exist today; not part
  of this work.
- **Multiple accounts per provider type** UI (schema already supports it, §6).
- **Free model / free local DuckDuckGo search** onboarding affordances — need a design
  for what "free" routes through (a hosted fallback reintroduces a backend dependency).

### Appendix: original standalone onboarding vision (context)

The eventual standalone flow this enables:

- User downloads Thunderbolt; chooses "log in to enterprise/beta account" **or** "set up
  my own model + search provider (advanced)".
- Two-step onboarding: choose a **model provider** (connect or key) then a **search
  provider** (skipped if a both-capability provider like Tinfoil is already connected),
  each with a live test before continuing, each skippable with a warning.
- Flows into the existing onboarding screens (privacy → auth → name → location →
  celebration), restructured into one full-screen coherent flow.
- Non-standalone deployments skip the provider steps (server supplies them) and go
  straight to login → normal onboarding.
