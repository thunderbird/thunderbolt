# System prompt, tools and citations

What a built-in model sees on a send: the system prompt
([`src/ai/prompt.ts`](../../../src/ai/prompt.ts)), the toolset
([`src/lib/tools.ts`](../../../src/lib/tools.ts), [`src/ai/fetch.ts`](../../../src/ai/fetch.ts)), and the
`[N]` contract behind each citation badge. Routing, retries, Stop and persistence:
[chat runtime](chat-runtime.md).

## Stable half vs volatile half

`createPromptParts` (`src/ai/prompt.ts:69`) returns `{ stablePrompt, volatilePrompt, fullPrompt }`
(`:47`). Everything the model is told lives in the stable half; the volatile half is the current
date/time and nothing else (`:95`, `:187`). Two engines consume the same `PromptParts`:

| Engine                                     | Assembled by                                        | Shape                                                                                                      |
| ------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Legacy (`aiFetchStreamingResponse`)        | `assembleBuiltInModelInput` (`src/ai/prompt.ts:59`) | `system` = stable prompt + per-send notes, joined by blank lines                                           |
| Pi harness (`src/acp/built-in-adapter.ts`) | `composeAppHarnessSystemPrompt` (`:544`)            | one string: stable prompt + client identity + environment block (tool-capable models only) + volatile date |

Why the split:

- **Prompt caching.** A byte-identical prefix stays cacheable; a timestamp near the front would
  invalidate it every send. Hence project instructions in the stable half and cross-chat recall as a
  _tool_ ([`project-prompt.ts:10`](../../../src/projects/project-prompt.ts),
  [`project-search-tool.ts:23`](../../../src/projects/project-search-tool.ts)).
- **Harness reuse.** `harnessSignature` (`src/acp/built-in-adapter.ts:526`) fingerprints the stable
  prompt plus the model descriptor. Editing project instructions rebuilds Pi's per-thread harness
  next send, no invalidation code needed; per-send text in the stable half would rebuild it every
  send.

The environment block (`shared/agent-core/environment-prompt.ts`) covers the virtual workspace and
simulated `bash`. The legacy and CLI paths have no workspace, so it stays out of the base prompt.

## Section order

The stable prompt, in source order:

| Section                | Content                                                                    | Source                                                                      |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Opening line           | Role, the active model's name, and the `[N]` citation rule                 | `src/ai/prompt.ts:121`                                                      |
| `# Principles`         | Answer discipline, prompt-injection refusal, unreadable-attachment honesty | `:124`                                                                      |
| `# Context`            | Preferred name, location, unit preferences, integration status             | built at `:104`, emitted at `:134`                                          |
| `# Project: <name>`    | Optional; the project's instructions, and a `search_project_chats` pointer | [`src/projects/project-prompt.ts`](../../../src/projects/project-prompt.ts) |
| `# Tools`              | The search-precedence ladder, per-turn budget wording, dedupe rules        | `:137`                                                                      |
| `## Link Previews`     | Link to individual item pages, never the aggregator that surfaced them     | `:159`                                                                      |
| `# Output Format`      | `[N]` placement, banned citation shapes, LaTeX delimiters                  | `:165`                                                                      |
| `# Language`           | Reply-language resolution, falling back to the app language                | `:176`                                                                      |
| `# Conversation Style` | `chatPrompt` plus the profile's `chatModeAddendum`                         | `:183`, [`src/ai/prompts/chat.ts`](../../../src/ai/prompts/chat.ts)         |

Two ordering invariants:

- **User-controlled text sits under `# Context`, never last** (`:120`). Trailing text reads to a
  model as the most authoritative instruction, which is what a prompt injection wants. Settings,
  location and project instructions are all user-controlled and all go in the middle.
  [Projects](projects.md) repeats the rule.
- **The math instruction and `rewriteMath` are complementary** (`:116`,
  `src/components/chat/markdown-blocks.ts:93`). The prompt asks for `$…$` / `$$…$$`; the renderer
  still rewrites `\(…\)` / `\[…\]`, because models drift. Dropping either regresses equation
  rendering.

`# Language` directs the _reply_ language. The prompt body and the injected date (`sourceLocale`)
stay English ([AGENTS.md](../../../AGENTS.md)).

## Conditional fragments

| Fragment                       | Included when                                                           | Source                                                |
| ------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `webToolsPrompt`               | `hasWebTools`: **both** `search` and `fetch_content` are in the toolset | `src/ai/fetch.ts:573`, `src/ai/prompts/web-tools.ts`  |
| `profile.toolsOverride`        | The model's `ModelProfile` sets it                                      | `src/ai/prompt.ts:86`, `:155`                         |
| `## Connected MCP Servers`     | `mergeMcpTools` merged at least one server's tools                      | `src/ai/fetch.ts:172`, `src/ai/prompt.ts:156`         |
| Skill disclosure               | Any enabled skill is disclosed to this model                            | `shared/agent-core/skills.ts`, `src/ai/prompt.ts:114` |
| `profile.linkPreviewsOverride` | The model's `ModelProfile` sets it                                      | `src/ai/prompt.ts:87`, `:163`                         |
| `# Project`                    | The project has instructions, or sibling chats to search                | `buildProjectPromptSection` (`src/ai/fetch.ts:588`)   |

`hasWebTools` comes from the toolset, not a setting, so a session without the web tools is never
told it has them. Skill disclosure has two shapes:

- **Tool-capable models:** `buildSkillListing` gives names, descriptions and a pointer to load full
  text via the `skill` tool.
- **`toolUsage === 0` models:** `buildFallbackSkillDisclosure` inlines full instructions, since no
  tool call can fetch them. `selectPromptSkillDefinitions` (`src/ai/fetch.ts:510`) narrows that to
  widget-rendering skills so the prompt does not balloon.

## Per-send notes

`buildVolatileSystemNotes` (`src/ai/fetch.ts:629`) orders the trailing system content: date/time,
voice-mode notes, instructions for skills resolved from `/slug` tokens, then a note replaying
answers to `ask` widgets.

Only the legacy path assembles these. Pi composes the date into its system string and carries
resolved skill instructions on the user turn (`prepareBuiltInConversation`,
`src/acp/built-in-conversation.ts:153`); voice and `ask` notes are read only in
`aiFetchStreamingResponse` (`src/ai/fetch.ts:902`). A new note needs a decision for both engines,
or it silently disappears from one.

## Tools: what exists, and when

`getAvailableTools` (`src/lib/tools.ts:39`) gates everything driven by settings and integration
status; `prepareAiRequestConfig` (`src/ai/fetch.ts:514`) adds the three that depend on the send's
own context.

| Tool(s)                               | Available when                                                          | Source                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `render_html`                         | Always (a core capability, not an integration)                          | [`src/artifacts/render-html-tool.ts`](../../../src/artifacts/render-html-tool.ts) |
| `addTasks`, `getTasks`, `deleteTasks` | `experimental_feature_tasks` (default `false`)                          | `src/extensions/tasks/tools.ts`                                                   |
| `search`, `fetch_content`             | `hasProAccess()` **and** `integrations_pro_is_enabled` (default `true`) | `src/integrations/thunderbolt-pro/tools.ts`                                       |
| `google_*` (5 tools)                  | `integrationStatus.googleEnabled` (connected _and_ not switched off)    | `src/integrations/google/tools.ts:546`                                            |
| `microsoft_*` (4 tools)               | `integrationStatus.microsoftEnabled`                                    | `src/integrations/microsoft/tools.ts:335`                                         |
| `skill`                               | The model supports tools (`model.toolUsage !== 0`)                      | `addSkillTool` (`src/ai/fetch.ts:490`)                                            |
| `search_project_chats`                | The thread belongs to a project that has sibling threads                | `src/projects/project-search-tool.ts`                                             |
| `<prefix>_<tool>`                     | An enabled MCP server exposes it and discovery succeeded this send      | `mergeMcpTools` (`src/ai/fetch.ts:172`)                                           |

- A `ToolConfig` (`src/types.ts:226`) carries `name`, `description`, `parameters` (Zod), a UI `verb`
  and an optional `cacheable` flag. `verb` is the loading phrase, `{param}` filled from the call's
  input (`src/lib/tool-metadata.ts:45`): `'searching for {query}'` → `Searching for "…"…`.
- `hasProAccess` resolves a hardcoded `isProUser = true`
  (`src/integrations/thunderbolt-pro/utils.ts:8`), so the settings flag is the only real gate on the
  web tools.
- `integrationStatus` distinguishes _connected_ from _enabled_. Connected-but-disabled contributes
  no tools and surfaces as `GOOGLE_DISABLED` / `MICROSOFT_DISABLED` in `# Context`
  (`src/ai/fetch.ts:580`), so the model explains rather than re-offering a dismissed connect widget.
- `ToolAvailabilityContext` (`src/lib/tools.ts:21`) only avoids duplicate database reads: the send
  path injects what it already loaded; cold callers (`src/lib/tool-metadata.ts:30`) let
  `getAvailableTools` self-fetch.

## Toolset assembly and the MCP merge

`createToolset` (`src/lib/tools.ts:142`) turns configs into AI SDK tools, wrapping each executor in
up to two layers:

- **Per-request dedupe**, `cacheable` tools only. Identical calls in one streaming response share
  the first promise; a rejection is evicted so the next call re-runs (`:94`). Never `cacheable` a
  write tool: the SDK's execute-options (`abortSignal`, `messages`, `toolCallId`) are not forwarded
  through the wrapper.
- **Budget accounting**, for the names in `webToolNames` (`:80`). A third web tool must be added to
  that set or it spends nothing and reports nothing.

MCP tools merge last, namespaced `<prefix>_<tool>` via `sanitizeToolPrefix` (`src/ai/fetch.ts:89`),
so two servers exposing `list_services` stay distinct. Colliding prefixes probe upward (`render`,
`render_2`, …); a name that still collides is skipped, first registered winning. Failed discovery
skips the server this send; it reconnects in the background.

`mergeMcpTools` alone knows the final name → server mapping, so it returns `mcpTools` metadata on
the assistant message: chat history resolves a `dynamic-tool` part to its server's name, URL and
icon by exact lookup, not a prefix guess.

Pi installs the converted toolset per send (`prepareHarnessForSend`,
`src/acp/built-in-adapter.ts:586`) over the harness's own `bash`, `read`, `write` and `edit`. Tools
are replaced every send, which is why live MCP client closures are deliberately _not_ part of
`harnessSignature`.

## The per-turn web budget

`search` and `fetch_content` share one per-turn budget
([`src/ai/web-tool-budget.ts`](../../../src/ai/web-tool-budget.ts)), capped by the turn's intent
(`:10`): `auto` 5, `search` 12, `research` 30. Intent comes from the skill token in the user's
message (`resolveWebToolIntent`, `src/ai/turn-web-budget.ts:17`); loading the research skill
mid-turn can promote an `auto` budget to the research cap once (`promote`,
`src/ai/web-tool-budget.ts:81`).

- **Calls are deduped before they are charged.** `normalizeWebToolKey` (`:126`) lowercases and collapses
  whitespace in a query, and normalizes a URL's host and path, so a repeated lookup costs nothing.
- **Exhaustion is a result, not an error.** A call past the cap resolves to
  `{ status: 'budget_exhausted', message }` (`:135`), and every web tool result carries a
  `Web calls remaining this turn: N` line from `createTool`'s `toModelOutput`
  (`src/lib/tools.ts:124`). `# Tools` tells the model those notices apply only to that turn
  (`src/ai/prompt.ts:145`); prompt text and enforcement change together. Pi's
  `installWebToolBudgetFloor` (`src/acp/built-in-adapter.ts:603`) steers the harness at the floor
  and un-steers it if a promotion reopens capacity.
- **The budget owns the turn's source registry.** `sourceCollector` hangs off the budget object
  (`:31`) so citation labels and cached web results share one lifetime; a different lifetime would
  renumber `[N]` mid-turn.

The chat layer creates the budget per turn; it survives auto-retries of the same prompt
([chat runtime](chat-runtime.md#budgets-and-retries)).

## The `[N]` citation contract

One index travels from tool result to badge in five steps across as many modules. Changing one
link requires changing the others.

1. **Assignment.** `search` and `fetch_content` push a `SourceMetadata` entry
   (`src/types/source.ts:9`) into the turn's `sourceCollector`, keyed by URL: a page fetched after
   it was searched reuses its index, and `fetch_content` (authoritative title) may enrich the entry
   in place (`src/integrations/thunderbolt-pro/tools.ts:110`). Past the 200-entry cap (`:23`),
   sources are dropped with a warning rather than renumbered.
2. **Disclosure.** Every result carries `[Source N] (cite as [N])` (`:70`, `:142`).
   `# Output Format` fixes placement: inline, same line, once per source, never a footnote or
   trailing list, never the model-native `【1】` (`src/ai/prompt.ts:165`). `webToolsPrompt` adds
   that a selected subset must never be renumbered.
3. **Persistence.** `createMessageMetadata` (`src/ai/message-metadata.ts:30`) snapshots the
   collector onto the message's `metadata.sources` each `finish-step`, so a reloaded conversation
   still resolves its citations.
4. **Cleanup.** Models drift, so `stripBracketCitations` (`src/ai/widget-parser.ts:122`) removes
   `【N†title】` and `【N】` before parsing. The regex requires the digits, sparing genuine CJK
   bracket text, and `TextPart` withholds a half-streamed `【…` suffix so the raw syntax never
   flashes on screen (`src/components/chat/text-part.tsx:165`).
5. **Rendering.** `buildSourceCitationPlaceholders` (`src/components/chat/text-part.tsx:81`)
   rewrites each run of `[N]` into one `{{CITE:key}}` placeholder plus a `CitationMap` entry, which
   `markdown-utils.tsx:115` swaps for an inline `CitationBadge`. Out-of-range indices stay literal.
   The grouping regex (`:36`) excludes `[1](…)` by negative lookahead so Markdown links survive; the
   same machinery serves Haystack document citations via `buildDocumentCitationPlaceholders`.

Two further consumers read the same registry:

- `WidgetRenderer` passes `sources` into _every_ widget's props
  (`src/components/chat/widget-renderer.tsx:50`), so `<widget:link-preview source="2" …/>` renders
  from registry metadata instead of refetching (`src/widgets/link-preview/widget.tsx:50`).
- The `citation` widget serves content that already carries structured sources and is _forbidden_ to
  the model by the prompt ([widgets.md](../widgets.md)).

`extractCitations` (`src/ai/eval/scoring.ts:19`) counts ASCII and fullwidth brackets, and scenarios
can assert `minCitations` (`:178`): a prompt edit that loosens citation discipline shows up there,
not in a type error.

## Changing any of this

| Adding                  | Requirements                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A prompt section        | Decide stable vs volatile (does it change per send?); place it so no user-controlled text trails; check both engines compose it                                                                |
| A tool                  | `ToolConfig` with a `verb`, gated explicitly in `getAvailableTools`; `cacheable` only if read-only and deterministic; usage text in the fragment beside its gate, never the unconditional body |
| A web-capable tool      | Add it to `webToolNames`, or it escapes the budget                                                                                                                                             |
| A source-producing tool | Write `SourceMetadata` into the injected `sourceCollector` with URL-keyed index reuse, or `[N]` alignment breaks for the turn                                                                  |

## Source map

| Concern                                    | File                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Prompt assembly, section order             | `src/ai/prompt.ts`                                                                                                      |
| Prompt fragments                           | `src/ai/prompts/chat.ts`, `src/ai/prompts/web-tools.ts`                                                                 |
| Skill disclosure and the `skill` tool      | `shared/agent-core/skills.ts`, `src/skills/skill-tool.ts`                                                               |
| Project section                            | `src/projects/project-prompt.ts`, `src/projects/project-search-tool.ts`                                                 |
| Tool availability, dedupe, budget wrapper  | `src/lib/tools.ts`                                                                                                      |
| Tool display metadata                      | `src/lib/tool-metadata.ts`                                                                                              |
| Per-send config, MCP merge, volatile notes | `src/ai/fetch.ts`                                                                                                       |
| Pi harness composition and tool install    | `src/acp/built-in-adapter.ts`, `src/acp/built-in-conversation.ts`                                                       |
| Web budget                                 | `src/ai/web-tool-budget.ts`, `src/ai/turn-web-budget.ts`                                                                |
| Source registry type                       | `src/types/source.ts`                                                                                                   |
| Citation parsing and rendering             | `src/components/chat/text-part.tsx`, `src/components/chat/markdown-utils.tsx`, `src/components/chat/citation-badge.tsx` |
| Native-bracket cleanup                     | `src/ai/widget-parser.ts`                                                                                               |

## Related

- [Chat runtime](chat-runtime.md): routing, retries, budgets, persistence.
- [Projects](projects.md): project instructions in the stable prompt.
- [Artifacts](artifacts.md): the `render_html` tool and its output.
- [Widgets](../widgets.md): what streamed text renders into, and the `sources` prop.
