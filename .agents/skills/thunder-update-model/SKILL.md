---
name: thunder-update-model
description: Swap a built-in model in the catalog (retire one, add its replacement) end to end, from a fresh worktree to a verified branch ready for /thunderpush.
disable-model-invocation: true
---

# Updating a built-in model

Swap one built-in model for its replacement: pick the model that leaves, the provider and model
that replace it, decide whether the row keeps its id, open a worktree from an up-to-date `main`,
delegate the edit to one implementer working through `references/swap-checklist.md`, review the
result, and hand the branch back for `/thunderpush`. The questions need the developer, so this
runs in the developer-facing session, not in a subagent.

## Read first

1. `references/swap-checklist.md` in this folder. It is the implementer's contract; skim it now so
   the questions below collect everything it needs.
2. `docs/internals/architecture/managed-inference.md` (routes, price rows, legacy slugs) and
   `docs/internals/architecture/reconciled-defaults.md#changing-a-default` (version bump, snapshot
   test, one-way retirement).
3. The catalog itself, `shared/defaults/models.ts`. Where a doc and the code disagree, the code
   wins.

## Argument

Up to four space-separated tokens, in this order: the leaving model (slug or export constant,
never a display name), the provider that serves the replacement, the incoming model id, and a
Linear ticket (`THU-nnn`). Each token answers its question below; ask only the questions that
remain. Claude Code passes them as `$ARGUMENTS`; other harnesses pass the text typed after the
skill name.

## Harness notes

Three actions differ by harness; every "ask" in the stages means the first row. Every other step
is plain shell.

| Action | Claude Code | Any other harness |
| --- | --- | --- |
| Ask the developer | AskUserQuestion: two to four options, Other is added automatically, header of 12 characters or fewer. | Print the numbered table and the options in chat, then wait for the developer's reply before continuing. Keep the question text as written. |
| Enter the worktree | `EnterWorktree({ path })`, loaded with ToolSearch (`select:EnterWorktree`). | Prefix every later shell command with `cd <absolute worktree path> &&` and use absolute paths. |
| Delegate the implementation | Agent tool with the highest tier alias its schema lists (`fable`, else `opus`), `effort: high`, no `isolation: "worktree"`. | Codex: a sub-agent thread if available, else implement in the same session. A harness without subagents: implement it yourself through the checklist, at the highest reasoning setting the harness offers. |

## Stages

### 0. Preflight

Run from any checkout or worktree; Orca worktrees are normal here. Record the main checkout and
refresh `main`:

```bash
MAIN=$(git worktree list --porcelain | head -1 | cut -d' ' -f2)
git fetch origin main
```

Every read in stages 1 to 4 goes through `git show origin/main:<path>`, because the local checkout
may be behind; the implementer revalidates inside the new worktree. Done when the fetch succeeded
and you printed MAIN.

### 1. Which model is leaving the catalog?

List the catalog from `origin/main`:

```bash
git show origin/main:shared/defaults/models.ts | awk '/^export const defaultModel[A-Za-z0-9]+: SharedModel = \{$/,/^}/' | grep -E "^(export const|  (id|name|provider|model|isConfidential|contextWindow): )"
git show origin/main:shared/defaults/models.ts | grep -E "^export const defaultModelId = "
```

For every provider in that list with a public catalog, mark deprecation. Today that is Tinfoil:

```bash
set -o pipefail; curl -fsS https://inference.tinfoil.sh/v1/models | jq -r '.data[] | select(.type=="chat") | "\(.id)\tdeprecated=\(.deprecated // false)\tdep_date=\(.deprecationDate // "-")\tctx=\(.context_window)\tmm=\(.multimodal)\ttools=\(.tool_calling)\texperimental=\(.experimental // false)\tin=\(.pricing.inputTokenPricePer1M)\tout=\(.pricing.outputTokenPricePer1M)"'
```

If that prints nothing, say the catalog could not be reached and continue without deprecation
marks. Print a table with name, slug, provider, confidential, export constant, shipped context
window, deprecated-on, and whether the row is `defaultModelId`. Then ask, header `Leaving`: "Which
model is leaving the catalog?" with the catalog rows as options (two to four; Other covers the
rest, so say "type the slug"). Put a deprecated row first and mark it "(Recommended)". With
fewer than two rows, ask a yes/no confirmation of the single candidate instead. Done when you hold
the leaving model's slug, uuid, display name, export constant, provider, `isConfidential`, shipped
`contextWindow`, and profile file (the one under `src/defaults/model-profiles/` whose `modelId` is
its id).

### 2. Which provider serves the replacement?

The options are the managed routes the backend implements today, read from code:

- confidential route: `provider: 'tinfoil'`, `isConfidential: 1`, served through `/v1/tinfoil/*`;
  the allowlist is derived from `defaultModels` in `backend/src/inference/managed-models.ts`.
- direct route: `provider: 'thunderbolt'`, `isConfidential: 0`, served through `/v1/chat/*`; the
  upstream vendor is the `provider` of the model's `managedDirectRuntimes` entry in that file.
  `getInferenceClient` in `backend/src/inference/client.ts` already has `anthropic` and
  `fireworks` clients, each with its settings key and deploy wiring. `ManagedDirectRuntime.provider`
  admits only `'anthropic'` today, so a direct Fireworks model widens that type and adds its
  runtime entry.

Ask, header `Provider`: "Which provider serves the replacement?" with one option per route, each
described in one line (transport, `provider` value, `isConfidential`), and the leaving model's own
route marked "(Recommended)". A vendor with no client in `getInferenceClient` (Google, Groq,
Mistral, xAI, OpenRouter, a BYOK provider) is integration work beyond a catalog swap: a settings
key, a client, env on Render, Helm and Pulumi. State that, point at checklist item 25, and stop. Done when the route, the `provider` value and `isConfidential` for the
incoming row are fixed.

### 3. Which model is replacing it?

Fetch models.dev once. Provider keys: anthropic, tinfoil, openai and openrouter map to themselves,
fireworks maps to `fireworks-ai`; for the direct route use the upstream vendor (Anthropic for
`opus-5`).

```bash
set -o pipefail; P=tinfoil; curl -fsS https://models.dev/api.json | jq -r --arg p "$P" '.[$p].models | to_entries | map(select((.value.modalities.input | index("text")) and .value.tool_call == true)) | sort_by(.value.release_date) | reverse | .[] | "\(.value.release_date)\t\(.key)\t\(.value.name)\tstatus=\(.value.status // "-")\tctx=\(.value.limit.context)\tout=\(.value.limit.output)\tin=\(.value.modalities.input|join(","))\treasoning=\(.value.reasoning)\t$\(.value.cost.input)/\(.value.cost.output)"'
```

The filter runs before the sort, so only text-input models with tool calling remain; Tinfoil's `type` field (chat, safety,
embedding) is checked in the cross-check below. Release dates are `YYYY-MM` or `YYYY-MM-DD`, so
the string sort holds; unknown dates go last. If the fetch fails or prints nothing, say so and
ask, header `Incoming`: "Type the incoming model id?" with options "I know the id (type it via
Other)" and "Stop here". Print the numbered table: #,
id, name, release date, status, context, output, input modalities, reasoning, $/M in/out. Cross-check
it against the provider's own catalog where one is public: Tinfoil with the curl from stage 1
(`deprecated`, `type`, `experimental`, `context_window`, `multimodal`, `tool_calling`, `pricing`,
and `reasoning_params`, which carries the effort map and the enable and disable body shapes),
OpenRouter at `https://openrouter.ai/api/v1/models`; Anthropic and OpenAI need a key, say so and
skip. Keep every row in the printed table, marked, but leave out of the options the leaving model,
models already in the catalog, and rows the provider marks deprecated or non-chat (`type != "chat"`
on Tinfoil). Ask, header `Incoming`: "Which model is replacing it?" with the four newest survivors
as options (two to four; mark the newest "(Recommended)") and the note "type a table number or the
exact id via Other". When exactly one survivor remains, ask a yes/no confirmation of that
candidate instead of a list. Done when you hold the incoming id, name, release date, status, context,
output, input modalities, reasoning, tools, list price, and the provider's own deprecation,
experimental, context, multimodal, tool-calling and reasoning-parameter facts where available.

### 4. Keep the existing model id or create a new one?

`frozenFields` in `src/lib/reconcile-defaults.ts` (`['isConfidential', 'provider']`) decides
which answer is legal:

- keep the id: `provider` and `isConfidential` are unchanged. The row keeps its uuid; `name`,
  `model`, `vendor`, `description` and `contextWindow` change; a lineage entry carries user-edited
  rows over. Threads, profiles and `selected_model` keep working, and the backend can ship the row
  OTA through `/config`. Recommended whenever legal.
- new id: either frozen field flips. Mint a new UUIDv7; the old row leaves `defaultModels` and
  `cleanupRemovedDefaults` soft-deletes it; threads bound to it fall back to the selected model.
  Needs a client build.

Ask both questions in one turn. First question, header `Model id`: "Keep the existing model id or
create a new one?", the legal recommendation first. Add a second question, header `Context`, only
when the leaving row's shipped `contextWindow` differs from the provider's value (131072 shipped
against 1048576 reported, for example): "Which context window should the row ship?" with "keep the
shipped value" and "adopt the provider value" as options. In the same message state the derived
facts the implementer will use: quota price = copy the leaving model's `inference_prices` row from
its seed migration (precedent `backend/drizzle/0029_seed-glm-5-3-prices.sql`, whose comment states
the policy); the provider list price is not used; image support = `'supported'` iff `image` is in
`modalities.input` and the provider agrees (`multimodal`); the profile inherits the leaving model's
`reasoningEffort` unless the catalog says `reasoning: false`, and checklist item 16 verifies that
level reaches the wire. Done when the developer answered and saw those facts.

### 5. Branch and worktree

Ask, header `Ticket`: "Is there a Linear ticket for this swap?" only when no `THU-nnn` was passed.
Options: "No ticket" (branch `ital0/chore-swap-<leaving-slug>-for-<incoming-slug>`) and "Linear
ticket" (the developer types `THU-nnn` via Other). With a ticket the branch is the one Linear
generates: the Linear MCP `get_issue` returns it as `gitBranchName`; the `linear` CLI, where
installed, returns `branchName` from `linear issue view THU-nnn --json --no-pager`. Then:

```bash
MAIN=$(git worktree list --porcelain | head -1 | cut -d' ' -f2)
git -C "$MAIN" worktree add "$MAIN/.claude/worktrees/<branch with / replaced by ->" -b <branch> origin/main
```

Enter the new path (see Harness notes). If you used the `cd` prefix, pass the same rule to the
implementer. Inside the worktree run `make setup` (root and backend deps) and
`cd cli && bun install` (the CLI has its own lockfile). Done when `git -C <path> status` is clean
on the new branch and both installs finished.

### 6. Delegate once

Hand the implementation to one implementer (see Harness notes). The worktree already exists and
you are in it, so the implementer gets no isolation of its own; reserve the maximum effort setting
for a stuck problem. When you implement it yourself, the brief below is your own contract. The
brief carries:

- leaving model: slug, uuid, export constant, display name, profile file, shipped `contextWindow`;
- incoming model: id, name, release date, status, context, output, modalities, reasoning,
  reasoning parameters, tools, price, experimental flag;
- provider route, the id decision, the context-window decision, the quota rule and the
  image-support value from stage 4;
- the reasoning requirement: the inherited `reasoningEffort` must reach the wire in the shape the
  provider documents (checklist item 16);
- the worktree's absolute path and, when you used the `cd` prefix, "all paths absolute, every
  shell command prefixed with `cd <path> &&`";
- "Read `.agents/skills/thunder-update-model/references/swap-checklist.md` and work through every
  item; report each item as done or not applicable with the path";
- no commits: the developer runs `/thunderpush`.

Completion criterion for the implementer, verbatim in the brief: every checklist item accounted
for, the final suites in checklist item 24 pass, and the item 23 grep report has no hit left in
the change class, with the legacy-keep, historical and current-identity hits listed with paths.
Done when the report arrives with those three things.

### 7. Review and hand off

Present, in this order: the checklist table from the implementer's report, the tail of each
verification command, the grep report, the deploy note from the checklist (it carries the OTA
hazard: a new compatibility alias must reach clients before the backend publishes the row), the
manual follow-up below, and the exact next command: `/thunderpush`. CI runs the deep review on the
PR, so do not start it here. Stop there; committing and pushing are the developer's call.

The manual follow-up is a production setting nobody automates: once the client release carrying
the swap is published, set `MIN_APP_VERSION` on the Render backend service to that release's
version so older builds get `426 Upgrade Required` instead of failing mid-chat (the gate is
`createAppVersionMiddleware`; the value applies on the next backend deploy). State the trigger
in the hand-off: a provider cutoff date (older clients break on that day regardless) or a new
compatibility alias from checklist item 16 (older clients break as soon as the row arrives).
Name the release version from checklist item 18 and say it is the developer's call to make,
after the release, by hand.

## Guardrails

- Never commit or push from this skill; `/thunderpush` owns that.
- Never run bare `bun test` at the repo root; use the scoped commands in the checklist.
- Never edit an existing migration SQL or snapshot; `_journal.json` only gains the new entry.
  Never edit `CHANGELOG.md` or a `.po` catalog.
