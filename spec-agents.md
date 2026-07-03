# Spec: Agents as the compartmentalization primitive

**Status:** Decisions locked via interview (2026-07-03); adversarially fact-checked against the codebase. Ready to break into tasks.

**Relationship to other specs:**

- Supersedes **Workspaces v1** (built entirely on this branch, never shipped — see §11).
- `spec.md` (provider primitive) survives, with four points superseded here:
  1. Models leave Settings; the catalog→row "Show in chat" toggle (spec.md §3/§8) gains an agent dimension and moves to the agent hub's Models tab (§7). The Providers page becomes connection management only.
  2. The single global `search_provider_id` (spec.md §7) is replaced by a per-agent search-provider pick (§3.2, §8.6).
  3. `providersSecretsTable` "local-only — never synced" (spec.md §2.2) is reversed: secrets sync, E2E-encrypted (§8.5).
  4. "No E2E-encryption work" no longer holds (§10).
- `spec-standalone-onboarding.md` survives, with two points superseded: the "on-device agent IS the (single) built-in agent" framing becomes the seeded default Thunderbolt agent **Zeus** (§13), and the onboarding steps that wrote the global `selected_model` / `search_provider_id` settings (its §§8–9) now write Zeus's per-agent fields. Everything else stands.
- Origin brief: `primitive-spec.md`. Terminology note: the brief's **"connectors"** maps to **integrations** (Google/Microsoft/Pro) — delivered as "user connects, agent enables" (§3.2). Per-agent integration *connections* (e.g. a different Gmail account per agent) are deferred (§14).

---

## 1. Thesis

The **agent** is the compartmentalization unit, not the workspace. An agent is a capability bundle — identity, instructions, models, modes, skills, MCP servers, integration access — that you point conversations at. Users can author multiple **Thunderbolt agents** (managed in the local DB, fully editable) and connect external **Connected agents** (ACP; opaque — they bring their own internals).

Around the agents sits a thin **user layer**: providers (connected accounts, per `spec.md`), integrations (OAuth connections), and a personal overlay of skills and MCP servers that follows the user into every agent. Workspaces are retired; **Projects** replace them as optional, purely organizational thread folders. Multi-user sharing leaves the app entirely — agent distribution to users/groups arrives later via a separate closed-source control plane.

## 2. The model at a glance

| Primitive | Scope | Notes |
|---|---|---|
| Agent | user | THE compartment. Thunderbolt (authored) or Connected (ACP, opaque) |
| Models, model profiles, modes | per-agent | Only meaningful inside a Thunderbolt agent — a model can't be injected via prompt. System/free models resolve into every agent at read time (§8.2) |
| Skills | per-agent **or** user overlay | `agent_id` set → that agent's; null → "My Skills", available in every agent |
| MCP servers | per-agent **or** user overlay | Same nullable-`agent_id` shape. Currently a local-only table — becomes synced (§8.2). Overlay reaches Connected agents only with per-agent consent |
| Providers | user | Connected accounts (per `spec.md`); agents draw models/search from them |
| Integrations (Google/Microsoft/Pro) | user connects, agent enables | OAuth once; each Thunderbolt agent toggles which it may use |
| Projects | user | Flat, optional folders for chat threads. No config, no membership |
| Chat threads | user | Pinned to their agent at creation; optional `project_id` |
| Settings, devices | user | Unchanged |

**Retired:** workspaces, workspace memberships (+ pending), workspace permissions, the workspace/user scope picker (`allowUserScopedResources`), `/w/:id` URLs, both workspace gates, `duplicateWorkspace`, prompts (legacy automations), triggers.

## 3. Agents

### 3.1 Taxonomy

- **Thunderbolt agent** — runs in-process on the existing built-in pipeline (`src/ai/fetch.ts`). A real synced DB row; users can create any number ("Create Thunderbolt agent"). Fully editable.
- **Connected agent** — external ACP agent ("Connect an agent"). Two flavors as today: user-added `remote-acp` rows and server-discovered `managed-acp` (`GET /agents`, cached in `agents_system`). Opaque: it owns its internal model/tools/skills; the app manages only wire identity, auth, and what the user chooses to pass in.

The hardcoded `builtInAgent` constant (`src/defaults/agents.ts`, id `thunderbolt-built-in`) is retired. Every agent is a row; every `type === 'built-in'` special case (connect.ts, chat-instance.ts, use-warm-acp-commands.ts, DAL guards, agent-row/selector, settings page) is replaced by `type === 'thunderbolt'` behavior driven off the row.

### 3.2 What a Thunderbolt agent contains

- **Identity:** name, icon, description.
- **Instructions:** an agent-level system prompt, layered above mode prompts (§5).
- **Models:** its own curated model rows (enabled from the user's provider catalogs, exactly as `spec.md`'s catalog→row flow, now stamped with the agent id) + a default model + per-model profiles. Deployment-provided system/free models are additionally available in every agent without per-agent rows (§8.2).
- **Modes:** its own mode set (seeded from defaults), each with its system prompt.
- **Skills:** its own skills, on top of the user overlay.
- **MCP servers:** its own servers, on top of the user overlay.
- **Integration access:** per-integration enable toggles (Gmail, Microsoft, Pro) selecting among the *user's* connections, plus a search-provider pick from the user's search-capable providers.
- **Per-agent memory of last-used model and mode** (replaces the global `selected_model` / `selected_mode` settings; exact semantics in §5).

A Connected agent stores: wire identity (name/type/transport/url/icon), per-agent auth (`agents_secrets`), and an **"Allow my MCP servers"** consent toggle (default off, §4).

### 3.3 Lifecycle

- **Seeding:** first run seeds one default Thunderbolt agent named **Zeus** — unless the deployment's "users may create Thunderbolt agents" policy flag (§12) is off, in which case nothing is seeded and users rely on managed agents.
- **Creating an agent:** a fresh Thunderbolt agent gets the default mode set (fresh ids), empty models (system/free models are still usable immediately via read-time resolution), empty skills, empty instructions, all integrations off, no search provider (web search falls back to the backend default, as today). If the user's providers offer models, the create flow lands on the agent's Models tab.
- **Duplicating an agent:** clones the agent row and all its agent-scoped rows (models, profiles, modes, skills, MCP servers) with fresh ids, remapping `default_model_id`/`last_model_id`/`last_mode_id` and copying integration toggles. Secrets are copied too (`agents_secrets`, per-server `mcp_secrets`) — they're the same user's credentials, E2E-encrypted.
- **Deleting:** any agent can be deleted, including the last one. With zero agents, the chat composer prompts to create or connect one (CTAs filtered by the §12 policy flags). Threads hold a hard `agent_id`: deleting an agent leaves its threads readable; resuming an orphaned thread asks the user to pick a new agent, which rewrites the thread's `agent_id` — the one sanctioned exception to "no mid-thread agent switching."
- Agent definitions sync across devices (PowerSync); their secrets sync too, E2E-encrypted (§8.5).

## 4. The user overlay

"My Skills" and "My MCP Servers" are user-level rows (`agent_id` null) that follow the user into every agent:

- **Skills** keep today's slash-trigger mechanics unchanged: an overlay skill's `/slug` is available in every agent's slash menu; resolution injects its instruction into the outgoing prompt (system message for Thunderbolt agents, folded into prompt text for Connected agents — exactly the current `resolveSkillTokenInstructions` / `composeAcpPrompt` paths). Connected agents resolve **overlay skills only** — they have no Skills tab and no agent-scoped skill rows.
- **MCP servers** attach to every Thunderbolt agent as real tools (merged and namespaced as today via `mergeMcpTools`). For Connected agents, the overlay's `http`/`sse` servers are passed through ACP `session/new` / `session/load` `mcpServers` (the field the app currently always sends empty) — **only when that agent's consent toggle is on** (default off). `stdio` servers are never passed (not reachable from a remote agent).

**Composition rule (default):** effective set = agent's rows ∪ overlay rows. On a name/slug collision, the agent's row wins and the overlay row is suppressed for that agent (surfaced in the agent's hub page, not a silent drop).

## 5. Chat-time resolution

Send to a **Thunderbolt agent** (replaces every `requireActiveWorkspaceId` lookup in `src/ai/fetch.ts` with agent-scoped resolution):

1. **Model** = the agent's last-used model (`last_model_id`, falling back to `default_model_id`). Model choice is per-agent sticky, not per-thread — the chat picker writes `last_model_id`; threads store no model column (matches today's behavior, where `selected_model` was globally sticky).
2. **Prompt** = base prompt + **agent instructions** + mode prompt (agent's mode set, per-agent sticky via `last_mode_id`) + model-profile addenda.
3. **Tools** = integrations the agent has enabled (drawing on user-level OAuth connections) + MCP tools (agent ∪ overlay) + Pro web search bound to the agent's search-provider pick.
4. **Skills** = slash resolution over agent ∪ overlay.

Send to a **Connected agent**: prompt text + resolved overlay-skill instructions, `mcpServers` per the consent toggle. Model/mode pickers are hidden, as today.

**MCP connections:** keep a single global connection pool keyed by server id (today's `MCPProvider`), synced from *all* enabled servers across agents + overlay; filter to the active agent's effective set at the `getEnabledClients(agentId)` boundary. Avoids connection churn on agent switch and keeps concurrent threads on different agents working.

**Selection state:** `settings.selected_agent` remains the global "last used agent" seeding new threads (default). On hydration, if it points at a missing/soft-deleted agent, fall back to the first live Thunderbolt agent, then first Connected agent, then the zero-agents composer state — and rewrite the setting. `selected_model`, `selected_mode`, and `search_provider_id` settings are retired in favor of per-agent state.

## 6. Projects

Flat, optional folders for threads. `projects` table (id, name, order, deletedAt, userId); threads get a nullable `project_id`. Sidebar shows project sections above/among the thread list; deleting a project reverts its threads to un-foldered (soft delete). No config semantics, no membership, no URL prefix, no gates. Future (out of scope): project-level context/instructions/files.

## 7. UX / IA

**Primary nav:** Chats · Projects (within the chat sidebar) · **Agents** · Settings.

**Agents** is a top-level destination, not a settings page:

- **List page** (`/agents`): all agents grouped Thunderbolt / Connected, with `Create Thunderbolt agent` and `Connect an agent` actions (the latter keeps the current custom-ACP dialog + connection test).
- **Agent hub page** (`/agents/:id`): identity header (icon, name, type badge, Chat / Duplicate / Delete actions) + tabs:
  - Thunderbolt: **Instructions · Models · Modes · Skills · MCP Servers · Integrations** (integration toggles + search provider pick). The Models tab hosts catalog browsing: "+ Add models" opens the user's provider catalogs and enables models *into this agent* (supersedes spec.md §8's placement of the toggle on the Provider detail page).
  - Connected: **Connection** (url/transport/auth/test) · **Access** (the "Allow my MCP servers" toggle) · advertised capabilities/commands, read-only.

**Settings** shrinks to genuinely user-level items: Providers (connection management only) · My Skills · My MCP Servers · Integrations (OAuth connections) · Preferences · Devices (· dev-only pages). The Extensions group as a workspace-global concept disappears.

**Anonymous/proxy deployments:** `/agents` stays visible everywhere (it hosts Thunderbolt agents). The current page-level hide (`useAgentsSettingsHidden`) is replaced by action-level gates: "Connect an agent" hidden/disabled where managed/custom ACP is unavailable, "Create Thunderbolt agent" gated by the §12 policy flag.

**Chat:** header agent selector grouped Thunderbolt / Connected (unchanged position); model and mode pickers show only the active agent's models/modes; both hidden for Connected agents. Landing page keeps the single unified thread list, filterable by agent, organized by project.

**URLs:** `/agents`, `/agents/:id`, `/agents/:id/<tab>`. The `/w/:workspaceId` prefix, `toWorkspaceUrl`/`useWorkspaceUrl` helpers, `WorkspaceGate`, and `WorkspaceMembershipGate` are removed (the app still gates on DB-ready; it no longer waits for a personal-workspace row).

## 8. Data model

### 8.1 `agents` (synced, reworked)

- `type` enum becomes `('thunderbolt','remote-acp','managed-acp')`; `url` nullable (null for Thunderbolt); `transport` nullable.
- New Thunderbolt-only columns: `instructions`, `default_model_id` (fallback when `last_model_id` is unset), `last_model_id`, `last_mode_id`, `search_provider_id`, `integrations_enabled` (JSON array of integration keys).
- New Connected-only column: `allow_user_mcp` (boolean, default false).
- Drop `workspace_id` and `scope`. Keep `user_id`, `enabled`, `deleted_at` (soft delete), `description`, `icon`.
- `agents_system` (device-local managed-acp discovery cache) is unchanged.

### 8.2 Per-agent resources

- `models`, `model_profiles`, `modes` gain `agent_id`; `skills` and `mcp_servers` gain a nullable `agent_id` (null = user overlay). All drop `workspace_id` and `scope`; DAL reads switch from `workspaceId` filters to `agentId` / overlay filters.
- **System/free models (decided):** deployment-provided rows (`isSystem`, thunderbolt provider, free tier) keep `agent_id` null and resolve into *every* Thunderbolt agent's model list at read time — no per-agent copies. So `agent_id` is required on user-created model rows only.
- **`mcp_servers` becomes a synced table** — today it is local-only (`src/db/powersync/schema.ts`), with no backend table or sync rule. This is a new synced table (backend schema + Drizzle migration + `shared/powersync-tables.ts` + sync rule + upload handler), not a re-scoping, and rides the two-PR deploy flow. Its missing-`scope` inconsistency dies here.

### 8.3 Threads and projects

`chat_threads`: drop `workspace_id`; `agent_id` required for new threads (legacy backfilled, §11); add nullable `project_id`; drop the vestigial `mode_id` (mode state is per-agent now; no per-thread model column either, per §5). New `projects` table per §6. `chat_messages`, `tasks` drop `workspace_id`.

### 8.4 Providers

`providers` drops `workspace_id`/`scope` → plain user-scoped rows. `getProviderById`/`getAllProviders`/`hydrateProviderModel`/model-catalog joins drop their workspace filters. Models keep `provider_id` FKs pointing at the user's providers — a deliberate cross-scope reference (per-agent model → user provider), same shape as agent → user integration.

### 8.5 Secrets — synced + E2EE (changed decision)

`providers_secrets`, `mcp_secrets`, `integrations_secrets`, and `agents_secrets` become **synced** tables so a second device doesn't re-enter every key. Concrete shape:

- Each gains `user_id` (+ timestamps), gets a backend table, a plain user-scoped bucket, and an upload handler; they are *always* defined as synced tables in the schema (PowerSync tables can't switch modes at runtime).
- Hard invariant: **credential columns leave the device only E2E-encrypted.** They join `encryptedColumnsMap` as always-encrypted, and the upload connector refuses to upload secret-table rows when E2EE is not set up — on E2EE-less deployments the rows simply stay local (today's behavior), never plaintext on the wire.
- Standalone is unaffected (no sync connection at all). `integrations_secrets` stays keyed by provider string — one Google + one Microsoft account per *user* (multi-account is future work, §14).

Known risk to design for: OAuth refresh-token races when two devices refresh the same synced token (§15).

### 8.6 Settings

Retired keys: `selected_model`, `selected_mode`, `search_provider_id`, `integrations_pro_is_enabled` (absorbed into per-agent integration toggles). Kept: `selected_agent`, `provider_setup_skipped`, preferences.

### 8.7 Defaults & reconciliation

Boot-time default seeding/reconciliation (today per-workspace, hash-based) becomes per-agent: reconcile by `(default_hash, agent_id)` so every agent's unedited seeded rows track shipped default updates. Default modes seed into each Thunderbolt agent; default skills seed into the **user overlay** on fresh install (matching migration §11.3 — skills reach every agent).

### 8.8 Export / import

Export excludes **all four** secrets tables (today `mcp_secrets`/`agents_secrets` leak into exports in plaintext while the other two are excluded — that asymmetry ends). The importer handles `agent_id` remapping and the removed workspaces/prompts/triggers tables. `schemaVersion` stays 1 — no released build ever produced a workspace-era export. `duplicateWorkspace` is deleted (agent duplication replaces it, §3.3).

## 9. PowerSync

All bucket definitions become user-scoped; the `workspace_data` and `user_scope_resources` buckets and `createWorkspaceScopedHandler` (with its permission keys) are replaced by plain user-scoped buckets/handlers. New synced tables: `projects`, `mcp_servers`, and the four secrets tables. Since Workspaces v1 never shipped, the production PowerSync dashboard still reflects main's pre-workspace rules — `config.yaml` on this branch is rewritten wholesale before merge, and the standard two-PR deploy flow applies against prod (backend/schema/sync-rules first, frontend second).

## 10. E2EE

- The per-row scope gate is deleted: on E2EE-enabled accounts, **every column in `encryptedColumnsMap` encrypts on upload, always**. `isRowInPersonalScope`, the per-batch `getPersonalWorkspaceByOwner` lookup in the connector, and the personal-vs-shared classification in `config.ts` all go. The silent-plaintext-downgrade path dies with them.
- Deployments/accounts without E2EE sync plaintext exactly as today — with the single exception of secret-table rows, which the upload connector holds locally rather than ever uploading plaintext (§8.5).
- `encryptedColumnsMap` extends to: `agents.{name,description,instructions}`, `projects.name`, and the secrets tables' credential columns. `workspaces.name` leaves the map with the table.
- THU-593 (workspace-aware multi-recipient envelopes) is obsolete: sharing left the app, so the single-CK model covers everything. Future agent distribution happens via the control plane serving agent definitions, not via multi-recipient sync encryption.

## 11. Sequencing & migration

**Workspaces v1 never ships.** The rework happens on this branch before merge; the branch keeps its provider / standalone / onboarding / MCP-OAuth work and replaces the workspace compartment layer. No user ever sees workspaces, so migration targets main's **pre-workspace** layout. The `pre-workspaces-attach` migration suite is replaced by a `pre-agents-attach` suite:

1. Seed **Zeus** for the existing user (subject to the §12 policy flag; if not seeded, step 7's backfill leaves legacy threads orphaned, which resume-and-re-pin handles).
2. Existing user-created `models`, `model_profiles`, `modes` rows → stamped with Zeus's `agent_id`. System rows (`isSystem`) keep `agent_id` null (§8.2).
3. Existing `skills` → user overlay (`agent_id` null). Today skills already inject into every agent (including ACP) — user-level preserves that behavior exactly.
4. Existing `mcp_servers` rows → user overlay, and the table starts syncing (§8.2); every Connected agent's `allow_user_mcp` defaults off, so ACP agents keep receiving zero MCP servers — no behavior change on migration day.
5. Existing `providers` rows → user-scoped as-is.
6. Finish the automations→skills migration (`src/lib/data-migrations/automations-to-skills.ts`, already in-flight); then drop `prompts` and `triggers` (tables soft-retired; scheduled runs return later as a designed per-agent feature).
7. Threads: `agent_id` null or `thunderbolt-built-in` → Zeus; existing custom/managed agent ids kept; `project_id` null.
8. Existing custom `agents` rows: re-typed under the new enum, workspace columns dropped.

Backend Drizzle migrations follow the house checklist (journal entry verified). Every synced-table change rides the two-PR deploy flow (§9).

## 12. Admin & deployment controls

**No in-app admin UI, no roles, no groups** (final decision — this supersedes an earlier interview answer that favored a minimal grants screen). Deployment-level env flags remain the interim story: `ENABLED_AGENTS` (which managed agents are served), `ALLOW_CUSTOM_AGENTS` (may users connect their own ACP agents), and `DISABLE_BUILT_IN_AGENT` is generalized to a **"may users create Thunderbolt agents"** policy flag (default: adaptation of the existing flag's intent) that also gates Zeus seeding (§3.3) and the create CTA (§7). The future closed-source control plane integrates through the existing `GET /agents` discovery seam (per-user/group grants, IDP groups) without reshaping the app.

## 13. Standalone reconciliation

`spec-standalone-onboarding.md`'s "the on-device agent IS the built-in Thunderbolt agent" becomes: **onboarding seeds Zeus and configures it**. The provider steps (with their hard test gates) connect user-level providers, enable the chosen catalog models *into Zeus* (setting its default model), and set Zeus's search provider — replacing that spec's writes to the retired `selected_model` / `search_provider_id` settings. The skip escape-hatch and `ProviderSetupBanner` nag are unchanged (providers are user-level). Standalone users can create additional Thunderbolt agents like anyone else. E2EE stays off and nothing syncs in standalone, so the secrets-sync invariant (§8.5) is moot there. All other locked standalone decisions stand.

## 14. Out of scope / future

- Agent sharing/distribution, per-user/group grants, IDP integration (control plane).
- Project context: instructions/files attached to a project.
- Chat-header quick-config drawer for the active agent (hub pages are the v1 surface).
- Multi-account integrations (work + personal Gmail) and per-agent account picking / per-agent connections.
- Per-agent scheduled runs (the designed successor to triggers).
- Agent templates / gallery.
- Passing integration tools to Connected agents (would require a tool-forwarding proxy layer).
- Per-agent skills for Connected agents (overlay-only in v1, §4).

## 15. Risks & open questions

- **OAuth refresh races:** synced integration/MCP OAuth credentials mean two devices may refresh the same (possibly rotating) refresh token concurrently. Needs a strategy before the secrets-sync task starts: refresh jitter + last-writer-wins on the synced row, or re-auth-per-device fallback for providers with rotating refresh tokens.
- **Reachability of overlay MCP servers from Connected agents:** a `localhost` HTTP MCP server passed via ACP `mcpServers` is unreachable from a remote agent. v1 passes the URL as-is and lets it fail visibly; a proxy/tunnel is future work.
- **`session/load` with changed `mcpServers`:** verify agents honor updated server lists on session resume; otherwise force a fresh session when the consent toggle flips. Decide before the ACP-passing task starts.
- **Zeus** as the seeded agent name: confirm it's a fixed product name (not localized, possibly deployment-configurable later).
