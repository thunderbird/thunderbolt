# Search and the Command Palette

`Cmd/Ctrl+K` opens one box that searches chats, messages, models, skills, agents, connections,
devices, projects and tasks, and runs commands ("New chat", "Create Skill", "Toggle sidebar", a jump
to any settings page). Every query is a SQLite statement against a local FTS5 index: no search page,
no search server, works offline, never leaves the device.

| Area                | File                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------- |
| Index DDL and build | [`src/search/fts-setup.ts`](../../src/search/fts-setup.ts)                             |
| Indexed entities    | [`src/search/registry.ts`](../../src/search/registry.ts)                               |
| Query planning      | [`src/search/query-plan.ts`](../../src/search/query-plan.ts)                           |
| Shared SQL pins     | [`src/search/search-sql.ts`](../../src/search/search-sql.ts)                           |
| Reactive query hook | [`src/search/use-search.ts`](../../src/search/use-search.ts)                           |
| Case/accent folding | [`src/search/fold.ts`](../../src/search/fold.ts)                                       |
| Result highlighting | [`src/search/highlight.tsx`](../../src/search/highlight.tsx)                           |
| Palette modal       | [`src/search/palette/`](../../src/search/palette/)                                     |
| Static commands     | [`src/search/commands/`](../../src/search/commands/)                                   |
| Inline entity edits | [`src/search/actions/`](../../src/search/actions/)                                     |
| Shortcut + provider | [`src/search/search-palette-context.tsx`](../../src/search/search-palette-context.tsx) |

Two design choices, not gaps:

- **Keyword only, no embeddings.** No vector store and no embedding model, so a query phrased
  differently from the indexed text misses. Wording-level mitigations for the project chat tool:
  [projects.md](./projects.md#cross-chat-search-is-keyword-only).
- **The index is derived state, never synced.** Rebuilt locally from replicated PowerSync data plus
  local-only tables, so it carries no `user_id`, needs no sync rule, and can be dropped and rebuilt
  at any time without data loss.

## The index

### Schema and ranking

One FTS5 virtual table, `search_index` (`buildCreateSql`,
[`src/search/fts-setup.ts:82`](../../src/search/fts-setup.ts#L82)):

| Column        | Tokenized        | bm25 weight | Role                              |
| ------------- | ---------------- | ----------- | --------------------------------- |
| `id`          | no (`UNINDEXED`) | 1.0         | stored for display and navigation |
| `entity_type` | no (`UNINDEXED`) | 1.0         | stored for display and navigation |
| `parent_id`   | no (`UNINDEXED`) | 1.0         | stored for display and navigation |
| `title`       | yes              | 10.0        | matched                           |
| `body`        | yes              | 1.0         | matched                           |

One table rather than one per entity lets the palette rank a chat against a skill against a device
in a single `ORDER BY`. Weights are positional over _every_ column, so the leading no-op `1.0`s in
`bm25(search_index, 1.0, 1.0, 1.0, 10.0, 1.0)` are the `UNINDEXED` ones. That expression and the
zero-based `body` index are pinned together in
[`src/search/search-sql.ts`](../../src/search/search-sql.ts) for two independent callers: change the
schema without moving both and search silently misranks.

### How rows get in

Population is entirely SQLite-side: three triggers per `searchEntities` entry (`AFTER INSERT`,
`AFTER UPDATE`, `AFTER DELETE`) on that entity's **PowerSync internal backing table**, reading
fields from its JSON `data` blob with `json_extract`.

- No application code in the path, whether the write came from the local UI or a sync download.
- `UPDATE` is a delete-then-conditional-insert guarded on
  `json_extract(NEW.data, '$.deleted_at') IS NULL`: setting `deleted_at` removes the row, clearing
  it restores the row.
- Tables without that column always index, since `json_extract` yields `NULL`.

### When it rebuilds

`createSearchIndex` ([`src/search/fts-setup.ts:146`](../../src/search/fts-setup.ts#L146)) runs at
boot as init step `step2d_build_search_index`, before the data steps and best-effort: a failed build
logs and boot continues with a stale or empty palette (see
[app-initialization.md](./app-initialization.md#the-search-index)). Two gates make it idempotent:

| Gate          | Check                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Version       | `searchIndexVersion` ([`src/search/registry.ts:135`](../../src/search/registry.ts#L135)), recorded in `search_index_meta`; a mismatch drops the previous generation and rebuilds |
| Trigger count | `searchEntities.length * 3` live triggers must exist                                                                                                                             |

The trigger count exists because PowerSync can drop and recreate its internal tables (a resync, a
schema update), taking the triggers with them while `search_index` survives; the version gate alone
would short-circuit and serve a stale index.

Coupling to `table.internalName` and to the `data` blob layout is the one real hazard: both are
undocumented `@powersync/web` internals, and an upgrade that renames or restructures them breaks
search with no TypeScript error and often no runtime error. Upgrade checklist:
[AGENTS.md](../../AGENTS.md#powersync-and-synced-tables).

### Adding an entity to the index

1. Append a `SearchEntityConfig` to `searchEntities`: PowerSync view (`tableName`), title field
   (`null` for messages, which have none), body fields (concatenated), optional parent-id field,
   and a `route` turning a hit into a router path. Field names are **snake_case database** names, read from the
   stored `data` blob rather than through Drizzle.
2. **Bump `searchIndexVersion`** in the same change, unconditionally. Adding or removing an entity
   changes the trigger count and forces a rebuild on its own, but any edit leaving the count intact
   (a renamed body field, one more field, a different tokenizer) is invisible to both gates and
   existing installs keep the old index.

- **Local-only tables are fair game.** `tableName` resolves against `AppSchema.tables`, and
  `mcp_servers` is already indexed as `localOnly`
  ([`src/db/powersync/schema.ts:38`](../../src/db/powersync/schema.ts#L38)), so the index spans
  `ps_data__*` and `ps_data_local__*`.
- **Exclusions are deliberate.** `settings`, `model_profiles`, `prompts`, `triggers` and every
  `*_secrets` table stay out: anything indexed becomes plaintext in a searchable local table.

## Querying

### How a term is routed

FTS5 ships no word-segmenting tokenizer, so `planSearchQuery`
([`src/search/query-plan.ts:109`](../../src/search/query-plan.ts#L109)) splits input across two
strategies:

| Term script                                          | Strategy                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| Anything `unicode61` can tokenize (Latin, Hangul, …) | quoted prefix `MATCH`, e.g. `"sao"*`                         |
| Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar   | word-split with `Intl.Segmenter`, matched as `LIKE '%term%'` |

The substring path is exact at any length, including the one- and two-character terms that dominate
Japanese and Chinese. Hangul is deliberately _not_ in the second row: Korean spaces its phrases, so
`unicode61` tokenizes it correctly. The strategies are ANDed at the SQL site, so `sao 天気` requires
both.

### Why neither the index nor the query path reads the app locale

The index holds _user content_, whose language is independent of the UI language and routinely mixed
within one account, and a language change must never rebuild the index. Full reasoning, including
the removed porter stemmer and the measured-and-rejected `trigram` index:
[AGENTS.md](../../AGENTS.md#powersync-and-synced-tables). Segmenters come from
[`src/lib/segmenter.ts`](../../src/lib/segmenter.ts), keyed on the content's own script.

### Consequences in the statement builder

`buildSearchStatement` ([`src/search/use-search.ts:70`](../../src/search/use-search.ts#L70)):

- **Wildcards must be escaped.** `toLikePattern` escapes `\`, `%` and `_`, paired with
  `ESCAPE '\'`. Without it a query containing `%` matches every row.
- **Snippets differ per path.** `snippet()` requires a `MATCH`, so a substring-only query centres a
  window on `instr(body, ?)` and marks either cut end with `…`.
- **Ranking falls back to `id DESC`.** No `MATCH` means nothing for bm25 to score; ids are UUIDv7
  and sort lexicographically by creation time.

### Highlighting

Highlighting must agree with matching or it marks nothing on a hit the user can plainly see, so
`HighlightMatch` marks the _planned_ terms rather than the raw query: `東京天気` matches a row
reading `東京の天気` and highlights `東京` and `天気`.

It folds with `foldForMatch` ([`src/search/fold.ts:60`](../../src/search/fold.ts#L60)), a JS mirror
of `remove_diacritics 2` that strips accents only where combining marks _are_ accents and keeps an
offset map into the original, so casing and diacritics survive in the rendered text. Both sides use
`toLowerCase`, never `toLocaleLowerCase`. Marking happens in React nodes rather than injected HTML,
hence the empty SQL `snippet()` markers.

## The palette

### Mounting and shortcut

`SearchPaletteProvider` owns the `Cmd/Ctrl+K` listener
([`src/search/search-palette-context.tsx:44`](../../src/search/search-palette-context.tsx#L44)) and
is mounted app-wide inside the `SidebarProvider`
([`src/layout.tsx:57`](../../src/layout.tsx#L57)) so the "Toggle sidebar" command can call the real
`useSidebar()`. The chat sidebar's search button
([`src/layout/sidebar/chat-actions.tsx:27`](../../src/layout/sidebar/chat-actions.tsx#L27), wired in
[`src/layout/sidebar/index.tsx:35`](../../src/layout/sidebar/index.tsx#L35)) is the only other
opener. There is no feature flag.

### Why the chunk is preloaded by hand

The chunk is loaded imperatively and held in state rather than through `React.lazy` + `Suspense`,
with the root starting the same import at boot
([`src/app.tsx:309`](../../src/app.tsx#L309)). `lazy` starts its factory on first render, so it
suspends even when the module is already in memory, and the boundary's reveal throttle withheld the
dialog for ~300ms after the promise had resolved (THU-846). Resolving it ourselves makes the first
`Cmd+K` a state toggle. The preload lives in the root because the provider sits behind the
`sidebar_state` settings gate.

### Inside the modal

In [`src/search/palette/search-palette.tsx`](../../src/search/palette/search-palette.tsx):

- Query debounced 180ms before `useSearch`, which does no delaying of its own; debouncing is
  deliberately the caller's concern. Results cap at 50, and previous results stay visible while the
  next query resolves.
- **cmdk's own filter is disabled** (`shouldFilter={false}`): it would re-filter FTS-filtered rows
  and wrongly hide valid prefix and substring hits.
- **Commands are not in the index.** A static list, titles locale-resolved at render, filtered by
  `commandMatchesQuery` using the same `foldForMatch` so `parametres` finds `Paramètres`. Titles are
  module-scope `msg` descriptors resolved during render
  ([i18n in AGENTS.md](../../AGENTS.md#module-scope-freezes-the-locale)).
- Results group by entity type in `searchEntities` order, so sections never reshuffle. Tasks stay
  indexed, but the group and the Tasks navigation command hide when `experimental_feature_tasks` is
  off, since `/tasks` is not mounted then and a click would 404.
- Model, Skill and Agent hits open the edit panel directly: the intent travels as JSON in
  `location.state` under a per-entity key, consumed by `useEntityActionIntent` on the target page
  ([`src/search/actions/`](../../src/search/actions/)). System models are excluded since they cannot
  be edited, and `remove` is never triggered from the palette, staying behind each detail panel's
  menu where ownership gates it. A message hit carries a scroll-to-message intent instead.
- Three PostHog events ([`src/lib/posthog.tsx:246`](../../src/lib/posthog.tsx#L246)):
  `search_palette_open` (closed→open transition, from the handler rather than an effect),
  `search_result_select`, `search_command_run`.

## The second consumer: `search_project_chats`

`searchProjectChats`
([`src/projects/project-search-tool.ts:62`](../../src/projects/project-search-tool.ts#L62)) exposes
the same index to the model, scoped to `entity_type = 'message'` and the current project's sibling
threads (see [projects.md](./projects.md#cross-chat-search-is-keyword-only)). It shares
`planSearchQuery`, `toLikePattern` and the `search-sql.ts` constants but builds its own statement,
since PowerSync's `useQuery` binds positionally while this path uses Drizzle `sql` templates. Its
snippets skip the truncation ellipses, which the model has no use for.

**Anything that changes the FTS schema has to be checked against both call sites.**

## Tests

`bun test src/search --timeout 5000`.

| File                              | Covers                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `fts-setup.test.ts`               | Generated statements as strings, then the triggers and the backfill end to end                                        |
| `query-plan.test.ts`              | Term routing and wildcard escaping                                                                                    |
| `fold.test.ts`                    | Per-script folding rules                                                                                              |
| `highlight.test.tsx`              | The marking                                                                                                           |
| `use-search.test.ts`              | The statement builder                                                                                                 |
| `palette/search-palette.test.tsx` | Edit-intent routing, the system model exception, the flag-gated Tasks group, command filtering with cmdk's filter off |

`fts-setup.test.ts` also asserts the tokenizer stays locale-independent and that `porter` does not
come back; its end-to-end pass runs against a real `bun:sqlite` database, soft-delete round trip
included. The palette test injects stub `useSearch`/`useCommands`/`trackEvent` props rather than
mocking the modules.
