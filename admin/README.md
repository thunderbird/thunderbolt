# Admin dashboard prototype and licensing proposal

**Prototype for design and licensing review; not a production admin system.**

This is an in-app, frontend-only proposal. It adapts the agent, member, group,
and access-management concepts from [to-be-coder/workspaces-rethink](https://github.com/to-be-coder/thunderbolt/tree/workspaces-rethink)
to current Thunderbolt components and styling. It does not carry over the
fork's separate app chrome, global CSS, backend, database tables, or API clients.

## Attribution and history

Original design and development credit belongs to **to-be-coder** and the
contributors recorded in that branch's Git history. Source tip:
cbd4f95f5856440fa35edcca3fe3644f21ee9d13.

The proposal preserves that complete commit ancestry with a merge, without
rewriting original authors or squashing their commits. The merge starts from
current main's tree and adds this adapted proposal, rather than importing
unrelated backend and application changes from the source branch. Preserve
that merge history when publishing or integrating the proposal; do not squash
or rebase away the source parents. GitHub profile attribution also depends on
each author's commit email being associated with their GitHub account.

The repository owner confirmed permission to relicense the admin code for
this proposal. The current admin files have the notice in LICENSE; historical
MPL versions remain available under their original license.

## Review the design

Run `bun install --frozen-lockfile`, then `bun run dev:admin` and open
`http://127.0.0.1:1426/admin`. This runs the actual Thunderbolt app with its
normal Chats, Settings, Admin, account menu, themes, and responsive navigation.
There is no separate Storybook shell or placeholder application page.

The command enables two separate switches:

- `VITE_ADMIN_DESIGN_PREVIEW=true` includes the lazy admin module. It presents
  an administrator's view; it is not real authorization or license enforcement.
- `VITE_ADMIN_LOCAL_REVIEW=true` injects local sample HTTP/auth/proxy clients
  through the app's existing provider interfaces. This bootstrap is DEV-only,
  requires a loopback host, and is excluded from production builds. It creates
  no valid server credential. Normal builds retain the application's real auth.

Use the dedicated origin above so review settings and the app's local database
stay separate from other Thunderbolt installations. The local review uses a
sample account and disables sync. Core settings use the real frontend database.
Backend-dependent operations (AI responses, email, sync, account changes) remain
unconnected; the injected clients return a local error for unsupported requests.

Admin edits are stored in the browser's `thunderbolt-admin-design` localStorage
entry, independently of core application records. They survive switching to
Chats or Settings and reloading the page. Reset sample data restores the samples.
The interaction model follows these source files at the credited commit:

- `src/admin/screens/thunderbolt-agent-detail-panel.tsx`: the built-in agent has
  company Skills and a Models tab with the Personal models policy. The updated
  proposal adds a Connections tab and moves Skills/Connections/Models editing into sidebar pages. It is not a company endpoint and has no rename, removal, or grants form.
- `src/admin/screens/registry-page.tsx`: independent policies allow personal ACP
  agents and the built-in Thunderbolt agent. Company rows show access and category.
- `src/admin/screens/agent-detail-panel.tsx`: company agents have Details, Access,
  and Preview sections; configuration includes name, ACP URL, category and About.
  Models/MCP/tools are read-only endpoint information. Preview shows member-facing
  card data and never exposes the ACP URL or raw server/tool wiring.
- `src/admin/screens/agent-access-tab.tsx`: Everyone, Admin only and Restricted
  are explicit access modes. Restricted grants can target groups or individuals;
  an empty list grants nobody access. Member details reflect effective grants.

The sidebar's **Thunderbolt agent** section contains Skills, Connections, and Models.
The agent's Skills, Connections, and Models tabs are read-only summaries; each item links directly
to its full editor. These pages reuse the user-facing SkillsList, SkillForm,
ConnectionsList, and MCP address fields. Both support enabling/disabling, editing,
and soft removal. Skill names, slugs, descriptions and instructions are editable;
MCP configuration includes name, URL and HTTP/SSE transport. Connections and
authentication remain inactive, and no credentials are collected or persisted.
The source had no configured Thunderbolt MCP servers, so the list starts empty.
Existing skill descriptions are retained, with instructions left blank for review.
Selection lives in the URL, including the agent's active tab, so links, refresh
and browser Back work normally.

Original agent/card fixtures are retained in `original-agent-fixtures.ts`.
Endpoint tests use recorded sample scenarios only; unknown endpoints have no
sample response.

Models reuse the user-facing ModelsList and provider/model form. The picker uses
the shipped Thunderbolt catalog; external providers allow explicit model IDs and
custom endpoints. There are no provider requests or stored API keys. Add, edit,
enable/disable and soft removal all operate on company records independently of
the personal library. The Personal models policy lives in the Models toolbar's
settings menu. Version 4 preserves prior skills, connections and policies while
adding an initially empty company model collection.

The Agents page labels registered endpoints as Custom agents beneath Thunderbolt.
Reset sample data is a toolbar icon; there is no sample-organization banner.

Version 2 migrates the earlier proposal's saved member/group and supported agent
edits, removes its invented model/MCP catalog, and restores the original policy
and card model. Version 3 retains that data and existing skill metadata, assigns
unique slugs and adds full local resource editing. The main application's real data is not modified.

Removal soft-deletes sample entities. No invitations are sent or access policies
enforced on a server.

## Shared implementation

Settings and admin share SectionSidebar; admin also imports the existing
SettingsLayout, SettingsListPane, AgentListRow, SettingsSelectableRow,
DetailPanelSurface, DetailPanel, PageHeader, PageCreateAction, and UI controls.
It has no separate theme or copied UI primitives. Both route and sidebar load
through one lazy module boundary.

The admin directory is included in type checking, linting, formatting,
localization extraction, license checks, and explicitly scoped tests. CI builds
the proposal too. The normal build keeps the admin feature switched off.

## Commercial terms

UNLICENSED — license TBD; explicitly not MPL for these files. This is not
The Unlicense. Enterprise support and licensing: info@thunderbolt.io.
