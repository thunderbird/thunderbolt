# Projects

A **project** is a workspace: durable instructions that every chat inside it
inherits, plus a place to see everything those chats produced. Modelled on Claude
Desktop's Projects, minus the document set — see [Knowledge, and why it
isn't here](#knowledge-and-why-it-isnt-here).

## Mental model

```
projects
    ^
    └──< chat_threads.project_id   (membership, nullable)
```

Two things flow from a project into a chat:

1. **Instructions** — injected into the system prompt on every send.
2. **`search_project_chats`** — a tool for looking through the project's *other*
   conversations.

Chats themselves stay isolated: one chat never sees another's transcript unless
the model explicitly searches for it.

## Knowledge, and why it isn't here

An earlier version of this feature carried a synced knowledge set: files attached
in a project's chats were run through the file transformers and stored as
extracted **text** (bytes could not be used — `src/lib/file-blob-storage.ts` keeps
attachment blobs device-local by design, so a binary knowledge base would only
work on the device that uploaded it).

That is **removed**, deliberately and completely: no `project_files` table, no
uploader, no aggregate view, no assistant-written notes, and no prompt budget.
What went with it is worth knowing, because it is what you would have to rebuild:

- A one-door file model (the composer was the only place a file was picked, and a
  chat's attachments were absorbed into its project).
- A ~12k-token context budget with whole-document inclusion and an eviction order
  that dropped assistant-written notes before anything the user added.
- `<document>` sandboxing, since a knowledge document could contain third-party
  text and had to be unable to close its own delimiter.

Chats in a project remain **searchable** — that never depended on knowledge — and
artifacts are still aggregated, because they are derived from message JSON rather
than stored as project rows.

## Prompt injection

`buildProjectPromptSection` renders a `# Project` block, and **where** it goes is
deliberate on two counts:

- **In the STABLE half of the prompt.** `createPromptParts` splits the system
  prompt into a cacheable prefix and a per-send suffix (the timestamp), and
  `harnessSignature` fingerprints the stable half. Project context in the stable
  half means prompt caching works across turns, and editing a project's
  instructions mid-thread rebuilds the harness by itself — no invalidation code.
- **Under `# Context`, never trailing.** `src/ai/prompt.ts` carries an explicit
  convention: user-controlled text must not sit last, where it reads as the
  most-recent instruction. Project instructions are user-controlled, so they
  follow it.

## Cross-chat search is keyword-only

`search_project_chats` runs against the app's FTS5 index (`search_index`,
`unicode61 remove_diacritics 2`, BM25 with titles weighted 10×), scoped to
`entity_type = 'message'` and the project's sibling threads. The current chat is
excluded — its history is already in context. Terms in scripts unicode61 cannot
tokenize (Japanese, Thai) are matched as substrings instead — see
`src/search/query-plan.ts`.

**There are no embeddings anywhere in the app.** A question phrased differently
from the original conversation will miss. Two mitigations, both in wording rather
than infrastructure:

- The tool description tells the model this is keyword search and to retry with
  synonyms before concluding a topic was never discussed.
- An empty result *explains why it might be empty*, rather than returning
  nothing — the likeliest failure of a lexical index is the model confidently
  reporting "you never discussed that" when only the vocabulary differed.

The prompt must also **advertise the tool** (`hasSearchableChats`). Without that
line the model reads its project context, sees no mention of other
conversations, and answers "I can't see your other chats" without ever calling
the tool that is sitting right there.

## Reactivity: queries must be compiled, not invalidated

`powersyncTableToQueryKeys` in `shared/powersync-tables.ts` *looks* like the
invalidation map for synced data. **It has had no consumer since THU-249** —
nothing reads it. Updates come from PowerSync's own reactivity, so a query only
refreshes if it is compiled through `toCompilableQuery`.

Every project read is therefore a reactive hook (`useProjects`, `useProject`,
`useProjectChats`, `useProjectArtifacts`, `useProjectChatCounts`).
An earlier version used plain TanStack queries with manual `refetch()` after each
edit; those went stale on any change from another device, and adding entries to
that map would have looked like a fix while doing nothing. The non-reactive
`getProject*` functions remain for callers outside React (the prompt path).

## Membership, and why it lives on the session

`chat_threads.project_id` is the source of truth, but a thread row isn't written
until the **first message save** (`getOrCreateChatThread`). So a chat started
from a project has to carry its project somewhere until then: `ChatSession.projectId`,
resolved at hydration from the persisted row or, for a new chat, the
`?projectId=` search param.

This mirrors `selectedAgent`, which exists on the session for exactly the same
reason. Dragging a chat into a project updates both the row and the live session
(guarded — `updateSession` **throws** on a chat that has no open session).

Deleting a project **orphans** its chats (`project_id` → null) rather than
deleting them. Deleting a workspace should never take a user's conversations with
it; removing the chats too is a separate, explicit action.

## UI surfaces

- **List** (`/projects` and `/projects/:projectId`, lazy) — **one component for
  both routes.** The id in the URL *is* the selection, so the panel opens with it;
  there is no separate detail page. That means a deep link, a sidebar row, a search
  hit, and the chat badge all land on the same surface, and a project is edited in
  exactly one place. Selection living in the route also means no effect syncing a
  param into state.
- **Slide-out** — two modes, mirroring the skills page: read-only, showing what the
  project *contains* (chats and artifacts, plus "New chat in this project"), and —
  via ⋯ → Edit — the same panel carrying the form. Read-only by default because a
  panel full of live inputs invites accidental edits while scanning the list;
  contents rather than settings because clicking a row asks "what's in here?", not
  "how is this configured?".
- **Create/edit form** — one `ProjectForm` for both, so the two can't drift: emoji,
  name, description, instructions. Deleting is confirmed from either entry point,
  sharing `deleteProjectPrompt`.
- **Chat header** — beside the agent selector, styled to match it (same height,
  `rounded-full`, background on hover only). Desktop shows the project's name;
  mobile shows an icon-only circle rendered *inside* the agent pill's positioned
  wrapper, so the pair docks together when the pill slides top-right.
- **Sidebar** — project rows double as drop targets, so a chat can be dragged into
  a project. "Remove from project" appears only while dragging a chat that has one.
  Five rows always, with the remainder behind an "N more" link to the list page, and
  the open project always shown.

  **The cap does not lift for a drag, and the drag affordance must not change
  layout.** It used to do both: on an account with ~100 projects the group grew from
  5 rows to 100 the instant a drag began (plus 8px of container padding), which
  pushed the grabbed chat row out from under the pointer and made the drop
  unaimable. Anything that changes this group's height mid-gesture reintroduces
  that. Projects past the cap are reached through **Move to project** in the chat's
  action menu, which gains a search field past 8 projects — a 100-row drop zone was
  never usable anyway.
- **Emoji icons** — the full Unicode set via `@emoji-mart/data`, dynamically
  imported so the entry chunk is unchanged, and virtualized because ~1,870 glyphs
  is far too many DOM nodes. Popover on desktop, bottom sheet on touch.

## Deploying this

> **Projects adds one synced table (`projects`), so the running PowerSync service
> must know about it before cross-device sync works.** Sync rules are baked into
> `ghcr.io/thunderbird/thunderbolt/thunderbolt-powersync` (built by
> `images-publish.yml` on merge), so a **new image has to be live on the Render
> `powersync` service** — see
> [powersync-account-devices.md](./powersync-account-devices.md#pr-flow-for-adding-tables).
>
> This ships as a single PR, which is safe but not instant. What happens on merge:
>
> - The backend's upload validator derives from `shared/powersync-tables.ts` (same
>   PR), so writes to `projects` are accepted and persisted in Postgres
>   immediately. **No data is lost.**
> - Until the `powersync` service runs the new image, the table has no buckets, so
>   **a second device sees nothing**. Projects looks fine on the
>   device that created it.
> - Once the image is live, PowerSync re-processes and clients receive the data.
>   The gap **self-heals**; it does not need a migration or manual repair.
>
> **The Render roll is manual** — the `powersync` service does not auto-deploy on
> a new image. After merge: wait for `images-publish.yml` to publish
> `thunderbolt-powersync`, then in the Render dashboard use
> **Manual Deploy → Deploy latest reference** on the `powersync` service, then
> verify a second device sees a project.
>
> Until that's done, treat cross-device Projects as not yet shipped.

`chat_threads.project_id` needs no sync-rule change — those rules are `SELECT *`.
Account deletion needs no code: the table cascades on `user_id`. Export needs no
code either; it derives from the PowerSync schema (its allowlist test will force
a conscious include/exclude on any future table).

## Source map

| Concern | File |
| --- | --- |
| Tables (frontend / backend) | `src/db/tables.ts`, `backend/src/db/powersync-schema.ts` |
| Encrypted columns | `src/db/encryption/config.ts` |
| Data access + live hooks | `src/dal/projects.ts` |
| Prompt section | `src/projects/project-prompt.ts` |
| Loading a send's project context | `src/projects/load-project-context.ts` |
| Cross-chat search tool | `src/projects/project-search-tool.ts` |
| Page + panels | `src/projects/{index,project-detail-panel,create-project-panel}.tsx` |
| Create/edit form (shared) | `src/projects/project-form.tsx` |
| Emoji icon picker | `src/projects/emoji-picker.tsx`, `src/projects/emoji-catalog.ts` |
| Drag-to-project | `src/projects/chat-drop.ts`, `src/layout/sidebar/project-drop-list.tsx` |
| Moving a chat (shared by drop + menu) | `src/projects/use-move-chat-to-project.ts` |
| Project picker (menu path, all platforms) | `src/projects/move-chat-to-project-dialog.tsx` |
| Chat header badge | `src/projects/project-badge.tsx` |

## Known gaps

- **Search is lexical, not semantic** (see above). True vector search needs an
  embedding model, a vector store, and a privacy decision about sending message
  text to a provider — none of which exist today.
- **Touch drag is unverified**, and on narrow mobile the sidebar's project rows
  are not rendered at all (the whole group sits behind `!isMobile`). Drag is
  therefore an enhancement, not the mechanism: every platform reaches project
  membership through **Move to project** in a chat's action menu (long-press on
  mobile, right-click or `⋯` on desktop), which opens `MoveChatToProjectDialog`. The
  sidebar owns one instance of that dialog rather than one per row — the list is
  virtualized and hundreds of rows long. Drag reaches only the five capped rows;
  the menu reaches every project.
- **E2EE has not been exercised.** The artifact query (`parts LIKE`) and the FTS
  index both assume message JSON is plaintext locally.
- **The pinned emoji category label is an overlay, not `position: sticky`.**
  `virtua` unmounts rows that leave the viewport, so a sticky in-flow heading
  disappears exactly when it should stick. The label is derived from the scroll
  offset instead (`findItemIndex`), which means it is driven by a scroll handler
  rather than by layout.
- **Remote and managed ACP agents get project instructions, but not the project
  tool.** ACP has no system channel, so `chat-instance.ts` renders the
  project section and the adapter folds it into the prompt text
  (`composeAcpPrompt`). `search_project_chats` stays built-in-only: it is an AI-SDK
  tool, and an ACP agent runs its own toolset, so advertising it would invite calls
  to something that does not exist. The
  lookup is gated on the session's `projectId`, so a chat outside a project never
  pays for it.
