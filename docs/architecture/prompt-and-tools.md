# System prompt, tools and citations

Three things decide what a built-in model actually sees on a send: the system prompt assembled by
[`src/ai/prompt.ts`](../../src/ai/prompt.ts), the toolset assembled by
[`src/lib/tools.ts`](../../src/lib/tools.ts) and [`src/ai/fetch.ts`](../../src/ai/fetch.ts), and the
`[N]` citation contract that ties a tool result back to the badge the user clicks. They belong on one
page because they are mutually load-bearing: the prompt teaches rules for tools that may not be
registered, the tools emit `[Source N]` labels the prompt tells the model how to spend, and the
renderer resolves those labels from metadata the tools collected on the way past.

[Chat runtime](./chat-runtime.md) owns the turn lifecycle — routing, retries, Stop, persistence.
This page starts at "a send has been routed to a built-in model" and ends at "the answer is on
screen".

## The prompt is two halves

`createPromptParts` (`src/ai/prompt.ts:69`) returns `{ stablePrompt, volatilePrompt, fullPrompt }`
(`:47`). Everything the model is told lives in the stable half; the volatile half is the current
date/time and nothing else (`:95`, `:187`).

The split pays for itself twice:

- **Prompt caching.** A prefix that is byte-identical across turns stays cacheable; a timestamp near
  the front would invalidate it on every send. This is why project instructions go in the stable
  half and why cross-chat recall is a _tool_ rather than an injection — see
  [`src/projects/project-prompt.ts:10`](../../src/projects/project-prompt.ts) and
  [`src/projects/project-search-tool.ts:23`](../../src/projects/project-search-tool.ts).
- **Harness reuse.** The Pi engine keeps one harness per thread, and `harnessSignature`
  (`src/acp/built-in-adapter.ts:526`) fingerprints the stable prompt along with the model
  descriptor. Editing a project's instructions mid-thread therefore rebuilds the harness on the next
  send with no invalidation code at all — and, symmetrically, moving per-send text into the stable
  half would rebuild the harness on _every_ send.

Two engines consume the same `PromptParts` and compose them differently:

| Engine                                     | Assembled by                                        | Shape                                                                                                      |
| ------------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Legacy (`aiFetchStreamingResponse`)        | `assembleBuiltInModelInput` (`src/ai/prompt.ts:59`) | `system` = stable prompt + per-send notes, joined by blank lines                                           |
| Pi harness (`src/acp/built-in-adapter.ts`) | `composeAppHarnessSystemPrompt` (`:544`)            | one string: stable prompt + client identity + environment block (tool-capable models only) + volatile date |

The environment block (`shared/agent-core/environment-prompt.ts`) describes the virtual workspace
and simulated `bash`, so it is deliberately kept out of the base prompt: the legacy and CLI model
paths have no workspace and must not be told they do.

## Section order, and why `# Context` never trails

In source order, the stable prompt is:

| Section                | Content                                                                    | Source                                                                   |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Opening line           | Role, the active model's name, and the `[N]` citation rule                 | `src/ai/prompt.ts:121`                                                   |
| `# Principles`         | Answer discipline, prompt-injection refusal, unreadable-attachment honesty | `:124`                                                                   |
| `# Context`            | Preferred name, location, unit preferences, integration status             | built at `:104`, emitted at `:134`                                       |
| `# Project: <name>`    | Optional; the project's instructions, and a `search_project_chats` pointer | [`src/projects/project-prompt.ts`](../../src/projects/project-prompt.ts) |
| `# Tools`              | The search-precedence ladder, per-turn budget wording, dedupe rules        | `:137`                                                                   |
| `## Link Previews`     | Link to individual item pages, never the aggregator that surfaced them     | `:159`                                                                   |
| `# Output Format`      | `[N]` placement, banned citation shapes, LaTeX delimiters                  | `:165`                                                                   |
| `# Language`           | Reply-language resolution, falling back to the app language                | `:176`                                                                   |
| `# Conversation Style` | `chatPrompt` plus the profile's `chatModeAddendum`                         | `:183`, [`src/ai/prompts/chat.ts`](../../src/ai/prompts/chat.ts)         |

Two ordering invariants are easy to break and hard to notice:

**User-controlled text sits under `# Context`, never last** (`src/ai/prompt.ts:120`). Anything
trailing reads to a model as the most recent — and therefore most authoritative — instruction, which
is exactly the leverage a prompt-injection attempt wants. Settings, location and project
instructions are all user-controlled and all go in the middle. [Projects](./projects.md) documents
the same rule from the project side.

**The math instruction and the renderer's normalization are complementary, not redundant**
(`:116`). The prompt asks for `$…$` / `$$…$$` only, and `rewriteMath`
(`src/components/chat/markdown-blocks.ts:93`) still rewrites `\(…\)` / `\[…\]` into their
`$`-delimited equivalents before rendering, because models drift. Dropping either side regresses
equation rendering.

`# Language` directs the _reply_ language while the prompt body itself stays English, and the
injected date formats with `sourceLocale` for the same reason. See the localization section of
[AGENTS.md](../../AGENTS.md) for why model-facing text is never translated.

## Conditional fragments

Most of the prompt is unconditional. These parts are not:

| Fragment                       | Included when                                                            | Source                                                |
| ------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `webToolsPrompt`               | `hasWebTools` — **both** `search` and `fetch_content` are in the toolset | `src/ai/fetch.ts:573`, `src/ai/prompts/web-tools.ts`  |
| `profile.toolsOverride`        | The model's `ModelProfile` sets it                                       | `src/ai/prompt.ts:86`, `:155`                         |
| `## Connected MCP Servers`     | `mergeMcpTools` merged at least one server's tools                       | `src/ai/fetch.ts:172`, `src/ai/prompt.ts:156`         |
| Skill disclosure               | Any enabled skill is disclosed to this model                             | `shared/agent-core/skills.ts`, `src/ai/prompt.ts:114` |
| `profile.linkPreviewsOverride` | The model's `ModelProfile` sets it                                       | `src/ai/prompt.ts:87`, `:163`                         |
| `# Project`                    | The project has instructions, or sibling chats to search                 | `buildProjectPromptSection` (`src/ai/fetch.ts:588`)   |

`hasWebTools` is computed from the toolset rather than from a setting, so a session without the web
tools is never told it has them — the reason that fragment is interpolated at all rather than
inlined.

Skill disclosure has two shapes, chosen by whether the model can call tools at all. Tool-capable
models get `buildSkillListing` — names and descriptions plus an instruction to load the full text
through the `skill` tool. Models with `toolUsage === 0` get `buildFallbackSkillDisclosure`, which
inlines every skill's full instructions because there is no tool call available to fetch them, and
`selectPromptSkillDefinitions` (`src/ai/fetch.ts:510`) narrows that set to widget-rendering skills so
the prompt does not balloon.

## Per-send notes

`buildVolatileSystemNotes` (`src/ai/fetch.ts:629`) orders the trailing system content: the date/time
first, then voice-mode notes, then instructions for skills resolved from `/slug` tokens in the user
message, then a note replaying the user's answers to `ask` widgets.

Only the legacy path assembles these. The Pi path composes the date into its single system string
(`composeAppHarnessSystemPrompt`) and carries resolved skill instructions on the user turn instead
(`prepareBuiltInConversation`, `src/acp/built-in-conversation.ts:153`); voice and `ask`-response
notes are read only in `aiFetchStreamingResponse` (`src/ai/fetch.ts:902`). A new injected note needs
a decision for both engines, or it silently disappears for whichever one you forgot — the same
divergence [chat runtime](./chat-runtime.md) warns about for ACP agents.

## Tools: what exists, and when

A tool is a `ToolConfig` (`src/types.ts:226`): `name`, `description` and `parameters` (a Zod object)
for the model, `verb` for the UI, and an optional `cacheable` flag. `verb` is the loading phrase
shown while the call runs, with `{param}` placeholders substituted from the call's input by
`src/lib/tool-metadata.ts:45` — `verb: 'searching for {query}'` renders as `Searching for "…"…`.

Availability is decided in two passes — `getAvailableTools` (`src/lib/tools.ts:39`) gates everything
driven by settings and integration status, and `prepareAiRequestConfig` (`src/ai/fetch.ts:514`) adds
the three tools that depend on the send's own context:

| Tool(s)                               | Available when                                                          | Source                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `render_html`                         | Always — a core capability, not an integration                          | [`src/artifacts/render-html-tool.ts`](../../src/artifacts/render-html-tool.ts) |
| `addTasks`, `getTasks`, `deleteTasks` | `experimental_feature_tasks` (default `false`)                          | `src/extensions/tasks/tools.ts`                                                |
| `search`, `fetch_content`             | `hasProAccess()` **and** `integrations_pro_is_enabled` (default `true`) | `src/integrations/thunderbolt-pro/tools.ts`                                    |
| `google_*` (5 tools)                  | `integrationStatus.googleEnabled` — connected _and_ not switched off    | `src/integrations/google/tools.ts:546`                                         |
| `microsoft_*` (4 tools)               | `integrationStatus.microsoftEnabled`                                    | `src/integrations/microsoft/tools.ts:335`                                      |
| `skill`                               | The model supports tools (`model.toolUsage !== 0`)                      | `addSkillTool` (`src/ai/fetch.ts:490`)                                         |
| `search_project_chats`                | The thread belongs to a project that has sibling threads                | `src/projects/project-search-tool.ts`                                          |
| `<prefix>_<tool>`                     | An enabled MCP server exposes it and discovery succeeded this send      | `mergeMcpTools` (`src/ai/fetch.ts:172`)                                        |

Note that `hasProAccess` resolves a hardcoded `isProUser = true`
(`src/integrations/thunderbolt-pro/utils.ts:8`), so the settings flag is in practice the only gate on
the web tools. `integrationStatus` distinguishes _connected_ from _enabled_: a connected-but-disabled
integration contributes no tools, and instead surfaces to the model as `GOOGLE_DISABLED` /
`MICROSOFT_DISABLED` in the `# Context` integration status (`src/ai/fetch.ts:580`) so it can explain
the situation rather than offering a connect widget the user already dismissed.

`ToolAvailabilityContext` (`src/lib/tools.ts:21`) exists only to avoid duplicate database reads: the
hot send path has already loaded settings and integration status for the prompt, so it injects them,
while cold callers (`src/lib/tool-metadata.ts:30`, which needs the configs purely for display
metadata) let `getAvailableTools` self-fetch.

`createToolset` (`src/lib/tools.ts:142`) turns configs into AI SDK tools, wrapping each executor in
up to two layers:

- **Per-request dedupe**, for `cacheable` tools only. Identical calls within one streaming response
  share the first promise; a rejection is evicted so the error surfaces and the next call re-runs
  (`:94`). Never set `cacheable` on a write tool — the execute-options the SDK would pass
  (`abortSignal`, `messages`, `toolCallId`) are not forwarded through the wrapper.
- **Budget accounting**, for the names in `webToolNames` (`:80`). A third web tool must be added to
  that set or it spends nothing and reports nothing.

MCP tools are merged last. Each server's tools are namespaced `<prefix>_<tool>` where the prefix is
the server name through `sanitizeToolPrefix` (`src/ai/fetch.ts:89`), so two servers exposing
`list_services` stay distinct; servers whose names sanitize to the same prefix are disambiguated by
probing upward (`render`, `render_2`, …), and a name that still collides with an existing tool is
skipped with first-registered winning. `mergeMcpTools` is the only place that knows the final
name → server mapping, so it returns `mcpTools` metadata that rides on the assistant message and lets
chat history resolve a `dynamic-tool` part back to its server's name, URL and icon by exact lookup
instead of a display-time prefix guess. A server whose discovery fails is skipped for this send and
reconnected in the background.

On the Pi path the assembled toolset is converted and installed per send by `prepareHarnessForSend`
(`src/acp/built-in-adapter.ts:586`), on top of the harness's own workspace tools (`bash`, `read`,
`write`, `edit`). Tools are replaced every send, which is why live MCP client closures are
deliberately _not_ part of `harnessSignature`.

## The per-turn web budget

`search` and `fetch_content` draw from one combined per-turn budget
([`src/ai/web-tool-budget.ts`](../../src/ai/web-tool-budget.ts)). The caps are keyed on the turn's
intent (`:10`): `auto` 5, `search` 12, `research` 30. Intent comes from the skill token in the user's
message — `resolveWebToolIntent` (`src/ai/turn-web-budget.ts:17`) — so `/research` buys a wider
budget than a bare question, and loading the research skill mid-turn can promote an `auto` budget to
the research cap once (`promote`, `src/ai/web-tool-budget.ts:81`).

Three details matter more than the numbers:

- **Calls are deduped before they are charged.** `normalizeWebToolKey` (`:126`) lowercases and
  collapses whitespace in a query, and normalizes a URL's host and path, so a repeated lookup costs
  nothing.
- **Exhaustion is a result, not an error.** A call past the cap resolves to
  `{ status: 'budget_exhausted', message }` (`:135`), and every web tool result carries a
  `Web calls remaining this turn: N` line appended by `createTool`'s `toModelOutput`
  (`src/lib/tools.ts:124`). The `# Tools` section tells the model those notices apply only to the
  turn that produced them (`src/ai/prompt.ts:145`) — prompt text and enforcement live in different
  files and must be changed together. On the Pi path `installWebToolBudgetFloor`
  (`src/acp/built-in-adapter.ts:603`) additionally steers the harness when the floor is hit, and
  un-steers it if a research promotion reopens capacity.
- **The budget owns the turn's source registry.** `sourceCollector` hangs off the budget object
  (`:31`) precisely so citation labels and cached web results share one lifetime; a collector with a
  different lifetime would renumber `[N]` mid-turn.

The budget itself is created per turn by the chat layer and survives auto-retries of the same prompt
— see [chat runtime](./chat-runtime.md#budgets-and-retries).

## The `[N]` citation contract

One index travels from a tool result to a clickable badge in five steps, across as many modules.
Changing any link requires changing the others.

1. **Assignment.** `search` and `fetch_content` push a `SourceMetadata` entry
   (`src/types/source.ts:9`) into the turn's `sourceCollector`, keyed by URL so a page fetched after
   it was searched reuses its index — and `fetch_content`, which has the authoritative title, is
   allowed to enrich the existing entry in place (`src/integrations/thunderbolt-pro/tools.ts:110`).
   The registry is capped at 200 entries (`:23`); past that, sources are dropped with a warning
   rather than renumbered.
2. **Disclosure.** Every result from either tool carries `[Source N] (cite as [N])` in its payload
   (`:70`, `:142`), and the prompt's `# Output Format` fixes the placement: inline, on the same
   line, once per source, never a footnote or a trailing source list, and never the model-native
   `【1】` shape (`src/ai/prompt.ts:165`). `webToolsPrompt` adds the rule that a selected subset of
   sources must never be renumbered.
3. **Persistence.** `createMessageMetadata` (`src/ai/message-metadata.ts:30`) snapshots the
   collector onto the assistant message's `metadata.sources` on each `finish-step`, so a reloaded
   conversation still resolves its citations.
4. **Cleanup.** Models drift anyway, so `stripBracketCitations`
   (`src/ai/widget-parser.ts:122`) removes `【N†title】` and `【N】` before parsing. Its regex
   deliberately requires the digits, leaving genuine CJK bracket text alone, and `TextPart` withholds
   a half-streamed `【…` suffix so the raw syntax never flashes on screen
   (`src/components/chat/text-part.tsx:165`).
5. **Rendering.** `buildSourceCitationPlaceholders` (`src/components/chat/text-part.tsx:81`) rewrites
   each run of `[N]` markers into a single `{{CITE:key}}` placeholder plus a `CitationMap` entry,
   which `markdown-utils.tsx:115` swaps for an inline `CitationBadge` inside the rendered Markdown.
   Out-of-range indices are left as literal text. The grouping regex (`:36`) excludes `[1](…)` by
   negative lookahead so Markdown links are never eaten, and the same machinery serves Haystack
   document citations through `buildDocumentCitationPlaceholders`.

Two further consumers read the same registry. `WidgetRenderer` passes `sources` into _every_ widget's
props (`src/components/chat/widget-renderer.tsx:50`), which is how
`<widget:link-preview source="2" …/>` renders instantly from registry metadata instead of refetching
the page (`src/widgets/link-preview/widget.tsx:50`). The `citation` widget exists for content that
already carries structured sources and is _forbidden_ to the model by the prompt — see the widget
table in [widgets.md](../features/widgets.md).

The eval suite scores this behaviour: `extractCitations` (`src/ai/eval/scoring.ts:19`) counts both
ASCII and fullwidth brackets, and scenarios can assert `minCitations` (`:178`). A prompt edit that
loosens citation discipline shows up there, not in a type error.

## Changing any of this

- **New prompt section** — decide stable vs volatile first (does it change per send?), then place it
  so no user-controlled text trails, then check both engines compose it.
- **New tool** — add a `ToolConfig` with a `verb`, register it in `getAvailableTools` behind an
  explicit condition, and set `cacheable` only if it is read-only and deterministic. If the model
  needs to be told how to use it, that text belongs in the prompt fragment beside its gate, not in
  the unconditional body.
- **New web-capable tool** — add its name to `webToolNames`, or it escapes the per-turn budget.
- **New source-producing tool** — write `SourceMetadata` into the injected `sourceCollector` with
  URL-keyed index reuse; anything else breaks `[N]` alignment for the whole turn.

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

- [Chat runtime](./chat-runtime.md) — the turn around this: routing, retries, budgets, persistence.
- [Projects](./projects.md) — how a project's instructions reach the stable prompt.
- [Artifacts](./artifacts.md) — the `render_html` tool and what it produces.
- [Widgets](../features/widgets.md) — what the streamed text can render into, including the `sources`
  prop every widget receives.
