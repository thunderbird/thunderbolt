# Search and the Command Palette

Press `Cmd/Ctrl+K` anywhere in the app and you get one box that searches your chats, messages,
models, skills, agents, connections, devices, projects and tasks, and also runs commands — "New
chat", "Create Skill", "Toggle sidebar", or a jump to any settings page. There is no separate
search page and no search server: every query is a SQLite statement against a local FTS5 index, so
search works offline and never leaves the device.

Two properties follow from that and are worth stating up front, because both are design choices
rather than gaps:

- **Keyword only, no embeddings.** There is no vector store and no embedding model anywhere in the
  app. A query phrased differently from the indexed text misses. The same trade-off, and the
  wording-level mitigations for it, are documented for the project chat tool in
  [projects.md](./projects.md#cross-chat-search-is-keyword-only).
- **The index is derived state, never synced.** It is rebuilt locally from whatever PowerSync has
  already replicated (plus local-only tables), so it carries no `user_id`, needs no sync rule, and
  can be dropped and rebuilt at any time without data loss.

## Where the code lives

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

## The index

Everything searchable lives in **one** FTS5 virtual table, `search_index`, with the columns
`id, entity_type, parent_id, title, body` (`buildCreateSql`,
[`src/search/fts-setup.ts:82`](../../src/search/fts-setup.ts#L82)). The first three are
`UNINDEXED` — stored so a hit can be displayed and navigated to, not tokenized. One table rather
than one per entity is what lets the palette rank a chat against a skill against a device in a
single `ORDER BY`.

Ranking is `bm25(search_index, 1.0, 1.0, 1.0, 10.0, 1.0)` — a title match counts ten times a body
match. The weights are positional over _every_ column, so the three leading no-op `1.0`s are the
`UNINDEXED` columns. That expression and the zero-based `body` column index live together in
[`src/search/search-sql.ts`](../../src/search/search-sql.ts) precisely because they are pinned to
the column layout above and there are two independent callers: change the schema and both constants
have to move at once, or search silently misranks.

Population is entirely SQLite-side. For each entry in `searchEntities` the builder installs three
triggers — `AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE` — on that entity's **PowerSync internal
backing table** and reads the fields out of its JSON `data` blob with `json_extract`. So the index
follows writes with no application code in the path, whether the write came from the local UI or
from a sync download. `UPDATE` is a delete-then-conditional-insert pair, which is how soft deletes
work: the re-insert is guarded on `json_extract(NEW.data, '$.deleted_at') IS NULL`, so setting
`deleted_at` removes the row from the index and clearing it puts the row back. Tables without the
column always index, because `json_extract` yields `NULL` there.

`createSearchIndex` ([`src/search/fts-setup.ts:146`](../../src/search/fts-setup.ts#L146)) runs once
at boot as init step `step2d_build_search_index`, before the data steps and best-effort — a failed
build logs and boot continues with a stale or empty palette. See
[app-initialization.md](./app-initialization.md#the-search-index) for its place in the sequence.

It is idempotent behind two gates. The first is `searchIndexVersion`
([`src/search/registry.ts:135`](../../src/search/registry.ts#L135)), a monotonic constant recorded
in a `search_index_meta` table; a mismatch drops the previous generation and rebuilds. The second is
a trigger count: PowerSync can drop and recreate its internal tables (a resync, a schema update),
which takes the triggers with them while `search_index` itself survives. Without counting them the
version gate would short-circuit and the index would go quietly stale, so the build also requires
`searchEntities.length * 3` live triggers.

That coupling to `table.internalName` and to the `data` blob layout is the subsystem's one real
hazard: both are undocumented `@powersync/web` internals, and a PowerSync upgrade that renames or
restructures them breaks search with no TypeScript error and often no runtime error. The upgrade
checklist for it is in [AGENTS.md](../../AGENTS.md#powersync-and-synced-tables).

### Adding an entity to the index

Append a `SearchEntityConfig` to `searchEntities`. The config names a PowerSync view (`tableName`),
the field to show as the title (`null` for messages, which have none), the fields concatenated into
the searchable body, and an optional parent-id field; field names are the **snake_case database**
names, since they are read out of the stored `data` blob rather than through Drizzle. `route` turns
a hit into a router path.

Then **bump `searchIndexVersion`** in the same change. Adding or removing an entity happens to
change the expected trigger count, so that gate would force a rebuild on its own; any edit that
leaves the count intact — a renamed body field, one more field on an existing entity, a different
tokenizer — is invisible to both gates, and existing installs keep serving the old index. Bumping
unconditionally is the rule that holds in every case.

Two things worth knowing before adding one. `tableName` is resolved against `AppSchema.tables`, so
local-only tables are fair game and one is already indexed — `mcp_servers` is `localOnly`
([`src/db/powersync/schema.ts:38`](../../src/db/powersync/schema.ts#L38)), which is why the index
spans `ps_data__*` and `ps_data_local__*` alike. And exclusions are deliberate: `settings`,
`model_profiles`, `prompts`, `triggers` and every `*_secrets` table are absent on purpose. Anything
you index becomes plaintext in a searchable local table, so secrets stay out.

## Querying

`planSearchQuery` ([`src/search/query-plan.ts:109`](../../src/search/query-plan.ts#L109)) turns raw
input into the two match strategies the index supports, because FTS5 ships no word-segmenting
tokenizer. Terms in a script `unicode61` can tokenize become a quoted prefix `MATCH` (`"sao"*`);
terms in a script it cannot — Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar — are word-split
with `Intl.Segmenter` and matched as `LIKE '%term%'` substrings instead — an exact substring test at
any length, including the one- and two-character terms that dominate Japanese and Chinese. Hangul is
deliberately _not_ in that set: Korean spaces its phrases, so `unicode61` tokenizes it correctly.
The two strategies are ANDed at the SQL site, so a mixed query like `sao 天気` requires both.

Nothing on the index or query path reads the app locale, and that is load-bearing rather than an
oversight: the index holds _user content_, whose language is independent of the UI language and
routinely mixed within one account, and a language change must never rebuild the index. The reasoning — including
why the porter stemmer was removed and why a parallel `trigram` index was measured and rejected — is
written up in [AGENTS.md](../../AGENTS.md#powersync-and-synced-tables). The segmenters themselves
come from [`src/lib/segmenter.ts`](../../src/lib/segmenter.ts), keyed on the content's own script for
the same reason.

Three consequences of the split path show up in `buildSearchStatement`
([`src/search/use-search.ts:70`](../../src/search/use-search.ts#L70)):

- **Wildcards must be escaped.** `toLikePattern` escapes `\`, `%` and `_` and the SQL pairs it with
  `ESCAPE '\'`. Without it a query containing `%` matches every row.
- **Snippets differ per path.** FTS5's `snippet()` requires a `MATCH`, so a substring-only query
  centres a window on `instr(body, ?)` and marks either cut end with the same `…`.
- **Ranking falls back to `id DESC`.** With no `MATCH` there is nothing for bm25 to score, and every
  id is a UUIDv7, which sorts lexicographically by creation time — newest-first for free.

Highlighting has to agree with matching or it marks nothing on a hit the user can plainly see.
`HighlightMatch` therefore marks the _planned_ terms rather than the raw query (so `東京天気`, which
matches a row reading `東京の天気`, highlights `東京` and `天気`), and folds them with `foldForMatch`
([`src/search/fold.ts:60`](../../src/search/fold.ts#L60)), a JS mirror of
`remove_diacritics 2` that strips accents only in scripts where combining marks _are_ accents and
keeps an offset map back into the original string so casing and diacritics survive in the rendered
text. Both sides fold with `toLowerCase`, never `toLocaleLowerCase`, for the locale-independence
reason above. This is also why the SQL `snippet()` markers are empty strings: marking is done in
React nodes, not injected HTML.

## The palette

`SearchPaletteProvider` owns the `Cmd/Ctrl+K` listener
([`src/search/search-palette-context.tsx:44`](../../src/search/search-palette-context.tsx#L44)) and
is mounted for the whole app inside the `SidebarProvider`
([`src/layout.tsx:57`](../../src/layout.tsx#L57)) — inside it so the "Toggle sidebar" command can
call the real `useSidebar()` toggle. The chat sidebar's search button
([`src/layout/sidebar/chat-actions.tsx:27`](../../src/layout/sidebar/chat-actions.tsx#L27), wired up
in [`src/layout/sidebar/index.tsx:35`](../../src/layout/sidebar/index.tsx#L35)) is the only other
opener. There is no feature flag.

The palette chunk is loaded imperatively and held in state rather than through
`React.lazy` + `Suspense`, and the root kicks the same import off during boot
([`src/app.tsx:309`](../../src/app.tsx#L309)). The reason is measured, not stylistic: `lazy` starts
its factory on first render, so it suspends even when the module is already in memory, and the
boundary's reveal throttle then withheld the dialog for ~300ms after the promise had resolved
(THU-846). Resolving it ourselves means the first `Cmd+K` is a state toggle. The provider sits behind
the `sidebar_state` settings gate, which is why the preload lives in the root and not in the
provider.

Inside the modal ([`src/search/palette/search-palette.tsx`](../../src/search/palette/search-palette.tsx)):

- The query is debounced 180ms before it reaches `useSearch`, which itself does no delaying —
  debouncing is deliberately the caller's concern. Results are capped at 50 and previous results
  stay visible while the next query resolves, so the list updates in place instead of flickering
  empty per keystroke.
- **cmdk's own filter is disabled** (`shouldFilter={false}`). It would re-filter the already
  FTS-filtered rows and wrongly hide valid prefix and substring hits.
- **Commands are not in the index.** They are a static list whose titles are locale-resolved at
  render time, filtered in-process by `commandMatchesQuery` — which folds with the same
  `foldForMatch`, so `parametres` still finds `Paramètres`. Command titles are module-scope `msg`
  descriptors resolved during render, for the reason described under
  [i18n in AGENTS.md](../../AGENTS.md#module-scope-freezes-the-locale).
- Results are grouped by entity type in `searchEntities` order, so the sections never reshuffle
  between queries. Tasks stay indexed but their group is hidden when the
  `experimental_feature_tasks` flag is off — as is the Tasks navigation command — because `/tasks`
  is not mounted then and a click would 404.
- Selecting a hit for Models, Skills or Agents opens its edit panel directly instead of dropping you
  on the settings page. The intent travels as JSON in `location.state` under a per-entity key and is
  consumed by `useEntityActionIntent` on the target page
  ([`src/search/actions/`](../../src/search/actions/)). System models are excluded — they cannot be
  edited — and `remove` is never triggered from the palette, staying behind each detail panel's menu
  where ownership gates it. A message hit instead carries a scroll-to-message intent.
- Three PostHog events: `search_palette_open` (fired on the closed→open transition, from the handler
  rather than an effect), `search_result_select` and `search_command_run`
  ([`src/lib/posthog.tsx:246`](../../src/lib/posthog.tsx#L246)).

## The second consumer

The palette is not the only thing that reads `search_index`. `searchProjectChats`
([`src/projects/project-search-tool.ts:62`](../../src/projects/project-search-tool.ts#L62)) exposes
the same index to the model as the `search_project_chats` tool, scoped to `entity_type = 'message'`
and the current project's sibling threads. It shares `planSearchQuery`, `toLikePattern` and the
`search-sql.ts` constants, but builds its own statement: PowerSync's `useQuery` binds positionally
while this path uses Drizzle `sql` templates, so the two binding models cannot share a builder. Its
snippets skip the truncation ellipses on purpose — the model has no use for them. See
[projects.md](./projects.md#cross-chat-search-is-keyword-only).

Anything that changes the FTS schema therefore has to be checked against both call sites.

## Tests

`fts-setup.test.ts` asserts the generated statements as strings — including that the tokenizer stays
locale-independent and that `porter` does not come back — then runs the triggers and the backfill
end to end against a real `bun:sqlite` database, soft-delete round trip included.
`query-plan.test.ts` covers term routing and wildcard escaping, `fold.test.ts` the per-script
folding rules, `highlight.test.tsx` the marking, and `use-search.test.ts` the statement builder.
`palette/search-palette.test.tsx` covers the behaviours above — the edit-intent routing, the system
model exception, the flag-gated Tasks group, and command filtering with cmdk's filter off — by
injecting stub `useSearch`/`useCommands`/`trackEvent` props rather than mocking the modules. Run
them with `bun test src/search --timeout 5000`.
