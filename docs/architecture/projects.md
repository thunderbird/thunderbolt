# Projects

A **project** is a workspace: durable instructions plus a text knowledge set that
every chat inside it inherits. Modelled on Claude Desktop's Projects, adapted to
constraints this app has and Claude's desktop client does not.

## Mental model

```
projects ──< project_files          (instructions + knowledge)
    ^
    └──────< chat_threads.project_id (membership, nullable)
```

Three things flow from a project into a chat:

1. **Instructions and knowledge** — injected into the system prompt on every send.
2. **`search_project_chats`** — a tool for looking through the project's *other*
   conversations.
3. **`save_project_note`** — an opt-in tool letting the assistant write a durable
   fact back into the project's knowledge.

Chats themselves stay isolated: one chat never sees another's transcript unless
the model explicitly searches for it.

## The constraint that shapes everything: knowledge is text

Claude's project knowledge is a persistent document set. This app cannot store it
that way, because attachment bytes are **device-local by design** —
`src/lib/file-blob-storage.ts` keeps them in IndexedDB and never syncs them, so
the file never touches our infrastructure.

A binary knowledge base would therefore work only on the device that attached it
and vanish when IndexedDB is cleared. So knowledge is **extracted text**: files
run through the same transformers chat attachments use
(`src/files/transformers`), and the resulting text is stored as an ordinary
synced, encrypted row.

### One door for files

There is no uploader on the project page. The **composer is the only place a file
is ever picked**; when the chat belongs to a project, `absorbChatAttachments`
extracts the text and adds it to the project's knowledge, so the project page
*aggregates* what the conversations brought in.

The bytes never move: they stay device-local on the message. The same file
therefore exists in two representations serving two purposes — native bytes for
that turn's model call, synced text for every future chat in the project.

Three properties worth knowing:

- **Scoped to the newest user turn.** The send-time save carries the *whole*
  conversation, so scanning every message would re-read and re-extract every
  earlier attachment on every later turn — parsing the same PDF once per message.
- **Idempotent by (filename, content).** Re-sending the same file adds one
  document; re-sending an edited file adds the new version rather than keeping
  the stale one.
- **Never throws.** A corrupt PDF must not fail the user's message; the file is
  delivered to the model either way, so absorption is best-effort.

Because the composer is the only door, **its accept list bounds what can become
knowledge**. `plainTextExtensions` and `resolveTextMimeType` therefore live in
`src/files/transformers` and are shared by both surfaces — the composer builds
its accept list from them, so a type added there reaches both instead of
silently one. MIME is normalized at attach time: a `.py` arrives with an empty
type, and unresolved that routes to *native bytes* a model cannot read.

Consequences worth knowing:

- **Model capability is irrelevant.** Unlike chat attachments (native-first —
  the PDF goes to the model as bytes), knowledge is just system-prompt text, so
  it works identically on every model. No per-model branching.
- **Images can never be knowledge.** There is no text form, so they are reported
  as skipped rather than silently dropped.
- **MIME types must be resolved from the extension.** File pickers report an
  empty `type` for `.md`, `.py`, `.yaml`, `.toml` and most configs, and `.ts` is
  commonly reported as `video/mp2t`. Keying purely off MIME rejected exactly the
  documents people reach for. See `resolveKnowledgeMimeType`.

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

### Budget and eviction order

There is no retrieval layer, so every knowledge document enters context verbatim.
`selectWithinBudget` fills a ~12k-token budget **in order**, whole documents
only — half a document is worse than none, because the model can't tell it was
truncated.

Order is the safety mechanism: `getProjectFiles` sorts user content (files from
chats and typed notes) ahead of assistant-written notes, so **anything the assistant wrote
is dropped before anything the user chose to add**. Whatever doesn't fit is named
in the prompt, so the model says "I don't have that document" instead of
answering from a partial knowledge base.

## Cross-chat search is keyword-only

`search_project_chats` runs against the app's FTS5 index (`search_index`,
porter/unicode61, BM25 with titles weighted 10×), scoped to
`entity_type = 'message'` and the project's sibling threads. The current chat is
excluded — its history is already in context.

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

## Assistant memory (notes)

Writing into a user's own knowledge base is not a normal tool, so it has three
guardrails:

| Guardrail | Why |
| --- | --- |
| **Opt-in per project** (`agent_notes_enabled`, default off) | A project never grows content the user didn't ask for |
| **Capped** (`maxAgentNotes`), refuses when full | Choosing which of the user's remembered facts to discard is not the tool's call |
| **Visible + deletable** (`origin: 'agent'`, badged) | Nothing is written invisibly |

The prompt distinguishes **three** states, because they need different wording —
one value rather than two booleans, since a boolean pair let a no-tool model be
told "you haven't enabled this" when the user had:

- `enabled` — use the tool, and say briefly that you did.
- `disabled` — the feature exists but the user hasn't opted in; say once when a
  fact *would* have been saved. This doubles as feature discovery.
- `unsupported` — opted in, but the model can't call tools. Says so **without**
  telling the user to enable a setting that is already on.

## Reactivity: queries must be compiled, not invalidated

`powersyncTableToQueryKeys` in `shared/powersync-tables.ts` *looks* like the
invalidation map for synced data. **It has had no consumer since THU-249** —
nothing reads it. Updates come from PowerSync's own reactivity, so a query only
refreshes if it is compiled through `toCompilableQuery`.

Every project read is therefore a reactive hook (`useProjects`, `useProject`,
`useProjectFiles`, `useProjectChats`, `useProjectArtifacts`, `useProjectChatCounts`).
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
deleting them; its knowledge documents are soft-deleted with it.

## UI surfaces

- **List** (`/projects`, lazy) — search, plus a read-only slide-out when a row is
  selected. The panel shows instructions and chats only; knowledge, assistant
  memory, and artifacts live behind ⋯ → Edit. A panel opened by browsing should be
  glanceable, and it carries no inputs so scanning can't cause an accidental edit.
- **Detail** (`/projects/:projectId`, lazy) — the editable page: name and emoji,
  instructions, knowledge (with per-origin badges), assistant memory opt-in,
  aggregated artifacts, and chats.
- **Chat header** — a badge naming the current project, beside the agent
  selector. Desktop only: the mobile header positions the agent pill absolutely
  and has no room beside it.
- **Sidebar** — project rows double as drop targets, so a chat can be dragged into
  a project. "Remove from project" appears only while dragging a chat that has
  one.
- **Emoji icons** — the full Unicode set via `@emoji-mart/data`, dynamically
  imported so the entry chunk is unchanged, and virtualized because ~1,870 glyphs
  is far too many DOM nodes. Popover on desktop, bottom sheet on touch.

## Deploying this

> **Projects adds two synced tables, so the running PowerSync service must know
> about them before cross-device sync works.** Sync rules are baked into
> `ghcr.io/thunderbird/thunderbolt/thunderbolt-powersync` (built by
> `images-publish.yml` on merge), so a **new image has to be live on the Render
> `powersync` service** — see
> [powersync-account-devices.md](./powersync-account-devices.md#pr-flow-for-adding-tables).
>
> This ships as a single PR, which is safe but not instant. What happens on merge:
>
> - The backend's upload validator derives from `shared/powersync-tables.ts` (same
>   PR), so writes to `projects` / `project_files` are accepted and persisted in
>   Postgres immediately. **No data is lost.**
> - Until the `powersync` service runs the new image, those tables have no
>   buckets, so **a second device sees nothing**. Projects looks fine on the
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
Account deletion needs no code: both tables cascade on `user_id`. Export needs no
code either; it derives from the PowerSync schema (its allowlist test will force
a conscious include/exclude on any future table).

## Source map

| Concern | File |
| --- | --- |
| Tables (frontend / backend) | `src/db/tables.ts`, `backend/src/db/powersync-schema.ts` |
| Encrypted columns | `src/db/encryption/config.ts` |
| Data access + live hooks | `src/dal/projects.ts` |
| Prompt section + budget | `src/projects/project-prompt.ts` |
| Loading a send's project context | `src/projects/load-project-context.ts` |
| Cross-chat search tool | `src/projects/project-search-tool.ts` |
| Note-saving tool | `src/projects/save-note-tool.ts` |
| Absorbing chat files into a project | `src/projects/absorb-chat-attachments.ts` |
| Text extraction + MIME resolution | `src/projects/extract-knowledge-text.ts`, `src/files/transformers/index.ts` |
| Pages + panels | `src/projects/{index,project-detail,project-detail-panel,create-project-panel}.tsx` |
| Emoji icon picker | `src/projects/emoji-picker.tsx`, `src/projects/emoji-catalog.ts` |
| Drag-to-project | `src/projects/chat-drop.ts`, `src/layout/sidebar/project-drop-list.tsx` |
| Chat header badge | `src/projects/project-badge.tsx` |

## Known gaps

- **Search is lexical, not semantic** (see above). True vector search needs an
  embedding model, a vector store, and a privacy decision about sending message
  text to a provider — none of which exist today.
- **Touch drag is unverified.** dnd-kit's `PointerSensor` on a virtualized,
  `touch-pan-y` list may compete with scrolling on mobile.
- **The project badge is desktop-only** — the mobile header positions the agent
  pill absolutely and has no room beside it.
- **Knowledge types are bounded by the composer's accept list**, since that is the
  only door. Images can never be knowledge (no text form); `html`/`svg` are
  excluded deliberately.
- **A document does not record which chat it came from.** `project_files` has no
  `chat_thread_id`, so the aggregate shows *what* but not *where from*.
- **E2EE has not been exercised.** `getProjectArtifacts` (`parts LIKE`) and the
  FTS index both assume message JSON is plaintext locally.
