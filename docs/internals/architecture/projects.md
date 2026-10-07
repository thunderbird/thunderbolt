# Projects

A **project** is a workspace: durable instructions every chat inside it
inherits, plus a view of what those chats produced. Modelled on Claude Desktop's
Projects, minus the document set ([why](#knowledge-and-why-it-isnt-here)).

## Mental model

```
projects
    ^
    └──< chat_threads.project_id   (membership, nullable)
```

| Flows into each chat   | What it is                                             |
| ---------------------- | ------------------------------------------------------ |
| Instructions           | Injected into the system prompt on every send          |
| `search_project_chats` | Tool for searching the project's _other_ conversations |

Chats are otherwise isolated: one never sees another's transcript unless the
model searches for it.

## Knowledge, and why it isn't here

An earlier version synced a knowledge set: files attached in a project's chats,
run through the file transformers and stored as extracted **text** (not bytes,
since `src/lib/file-blob-storage.ts` keeps attachment blobs device-local). It is
removed completely: no `project_files` table, uploader, aggregate view,
assistant-written notes, or prompt budget. Rebuilding it means rebuilding:

- a one-door file model (the composer was the only file picker, and a chat's
  attachments were absorbed into its project);
- a ~12k-token budget with whole-document inclusion, evicting assistant-written
  notes before anything the user added;
- `<document>` sandboxing, so a knowledge document carrying third-party text
  cannot close its own delimiter.

Chats in a project stay **searchable** (never dependent on knowledge), and
artifacts are still aggregated because they derive from message JSON.

## Prompt injection

`buildProjectPromptSection` renders a `# Project` block. Placement is deliberate:

- **STABLE half of the prompt.** `createPromptParts` splits the system prompt
  into a cacheable prefix and a per-send suffix (the timestamp), and
  `harnessSignature` fingerprints the stable half. Caching works across turns,
  and editing instructions mid-thread rebuilds the harness by itself with no
  invalidation code.
- **Under `# Context`, never trailing.** `src/ai/prompt.ts` requires that
  user-controlled text not sit last, where it reads as the most-recent
  instruction.

## Cross-chat search is keyword-only

`search_project_chats` queries the FTS5 index (`search_index`,
`unicode61 remove_diacritics 2`, BM25 with titles weighted 10×), scoped to
`entity_type = 'message'` and the project's sibling threads. The current chat is
excluded; its history is already in context. Scripts unicode61 cannot tokenize
(Japanese, Thai) fall back to substring matching (`src/search/query-plan.ts`).

**There are no embeddings anywhere in the app**, so a differently-phrased
question misses. Two mitigations, both wording:

- the tool description says this is keyword search, and to retry with synonyms;
- an empty result _explains why it might be empty_, since the likeliest failure
  of a lexical index is the model reporting "you never discussed that" when only
  the vocabulary differed.

The prompt must also **advertise the tool** (`hasSearchableChats`). Without that
line the model answers "I can't see your other chats" without ever calling it.

## Reactivity: compile queries, don't invalidate them

`powersyncTableToQueryKeys` (`shared/powersync-tables.ts`) looks like the
invalidation map for synced data but **has had no consumer since THU-249**.
Updates come from PowerSync's own reactivity, so a query refreshes only if it is
compiled through `toCompilableQuery`.

Every project read from React is a reactive hook: `useProjects`,
`useProjectChatCounts`, `useProjectChats`, `useProjectArtifacts`. Plain TanStack
queries with manual `refetch()` went stale on changes from another device, and
adding map entries would have looked like a fix while doing nothing. A single
project is read with the non-reactive `getProject`, which with the other
`getProject*` functions serves callers outside React (the prompt path).

## Membership lives on the session

`chat_threads.project_id` is the source of truth, but the row isn't written until
the **first message save** (`getOrCreateChatThread`). Until then a chat carries
`ChatSession.projectId`, resolved at hydration from the persisted row or, for a
new chat, the `?projectId=` search param. `selectedAgent` works the same way.

Dragging a chat into a project updates both the row and the live session;
`updateSession` **throws** on a chat with no open session.

Deleting a project **orphans** its chats (`project_id` → null). Deleting a
workspace must never take conversations with it; removing them is a separate,
explicit action.

## UI surfaces

| Surface                                              | Notes                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **List** (`/projects`, `/projects/:projectId`, lazy) | One component for both routes. The URL id _is_ the selection, so deep link, sidebar row, search hit and chat badge land on the same surface, and no effect syncs a param into state.                                                                                |
| **Slide-out**                                        | Two modes, mirroring the skills page: read-only by default (chats, artifacts, "New chat in this project"); ⋯ → Edit swaps in the same panel's form. Live inputs by default invite accidental edits while scanning.                                                  |
| **Create/edit form**                                 | One `ProjectForm` for both so they can't drift: emoji, name, description, instructions. Delete confirms through `deleteProjectPrompt` from either entry point.                                                                                                      |
| **Chat header**                                      | Beside the agent selector, matching height, `rounded-full`, background on hover only. Desktop shows the project's name; mobile renders an icon-only circle _inside_ the agent pill's positioned wrapper, so the pair docks together when the pill slides top-right. |
| **Sidebar**                                          | Project rows are drop targets; "Remove from project" shows only while dragging a chat that has one. Five rows plus the open project, remainder behind an "N more" link to the list page.                                                                            |
| **Emoji icons**                                      | Full Unicode set via `@emoji-mart/data`, dynamically imported (entry chunk unchanged) and virtualized (~1,870 glyphs). Popover on desktop, bottom sheet on touch.                                                                                                   |

**The sidebar cap does not lift for a drag, and the drag affordance must not
change layout.** It used to do both: with ~100 projects the group grew from 5
rows to 100 the instant a drag began (plus 8px of container padding), pushing the
grabbed chat row out from under the pointer. Anything that changes this group's
height mid-gesture reintroduces it. Projects past the cap are reached through
**Move to project**, which gains a search field past 8 projects.

## Deployment

One synced table (`projects`). Its bucket rule shipped with the feature in #1215
(2026-08-17) and is present in all three sync-rule configs:
`powersync-service/config/config.yaml`, `deploy/config/powersync-config.yaml` and
`deploy/k8s/templates/configmaps.yaml`.

Rules and frontend shipped in one PR: safe, but not instant. The backend's upload
validator derives from `shared/powersync-tables.ts`, so writes persisted in
Postgres from merge and no data could be lost. But sync rules are baked into
`ghcr.io/thunderbird/thunderbolt/thunderbolt-powersync` (built by
`images-publish.yml` on merge) and the Render `powersync` service does **not**
auto-deploy, so until that roll the table had no buckets and a second device saw
nothing. Once the image is live PowerSync re-processes and the gap self-heals,
with no migration or manual repair. Procedure, including the manual Render roll:
[powersync-account-devices.md](powersync-account-devices.md#pr-flow-for-adding-tables).

`chat_threads.project_id` needs no sync-rule change; those rules are `SELECT *`.
Account deletion needs no code: the table cascades on `user_id`. Export derives
from the PowerSync schema, whose allowlist test forces a conscious
include/exclude on any future table.

## Source map

| Concern                                              | File                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Tables (frontend / backend)                          | `src/db/tables.ts`, `backend/src/db/powersync-schema.ts`                                                   |
| Encrypted columns                                    | `src/db/encryption/config.ts`                                                                              |
| Data access + live hooks                             | `src/dal/projects.ts`                                                                                      |
| Prompt section                                       | `src/projects/project-prompt.ts`                                                                           |
| Loading a send's project context                     | `src/projects/load-project-context.ts`                                                                     |
| Cross-chat search tool                               | `src/projects/project-search-tool.ts`                                                                      |
| Page + panels                                        | `src/projects/{index,project-detail-panel,create-project-panel}.tsx`                                       |
| Page state machine (overlay + delete flow)           | `src/projects/projects-view-state.ts`                                                                      |
| Create/edit form (shared)                            | `src/projects/project-form.tsx`                                                                            |
| Emoji icon picker                                    | `src/projects/emoji-picker.tsx`, `src/projects/use-emoji-picker-state.ts`, `src/projects/emoji-catalog.ts` |
| Project glyph (chosen emoji, or the folder fallback) | `src/projects/project-icon.tsx`                                                                            |
| Drag-to-project                                      | `src/projects/chat-drop.ts`, `src/layout/sidebar/project-drop-list.tsx`                                    |
| Moving a chat (shared by drop + menu)                | `src/projects/use-move-chat-to-project.ts`                                                                 |
| Project picker (menu path, all platforms)            | `src/projects/move-chat-to-project-dialog.tsx`                                                             |
| Chat header badge                                    | `src/projects/project-badge.tsx`                                                                           |

## Known gaps

- **Search is lexical, not semantic.** Vector search needs an embedding model, a
  vector store, and a privacy decision about sending message text to a provider.
- **Touch drag is unverified**, and narrow mobile doesn't render the sidebar
  project group at all (`!isMobile`). Drag reaches only the five capped rows;
  every platform reaches membership through **Move to project** in a chat's
  action menu (long-press on mobile, right-click or `⋯` on desktop), which opens
  `MoveChatToProjectDialog`. The sidebar owns one dialog instance rather than one
  per row, since the list is virtualized and hundreds of rows long.
- **E2EE has not been exercised.** The artifact query (`parts LIKE`) and the FTS
  index both assume message JSON is plaintext locally.
- **The pinned emoji category label is an overlay, not `position: sticky`.**
  `virtua` unmounts offscreen rows, so a sticky in-flow heading disappears
  exactly when it should stick. The label derives from the scroll offset
  (`findItemIndex`), driven by a scroll handler rather than by layout.
- **Remote and managed ACP agents get project instructions, not the project
  tool.** ACP has no system channel, so `chat-instance.ts` renders the section
  and the adapter folds it into the prompt text (`composeAcpPrompt`).
  `search_project_chats` is an AI-SDK tool and an ACP agent runs its own toolset,
  so advertising it would invite calls to something that does not exist. The
  lookup is gated on the session's `projectId`, so a chat outside a project
  never pays for it.
