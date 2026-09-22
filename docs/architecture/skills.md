# Skills

A skill is a named, reusable block of instructions stored as a row in the synced `skills` table. It
reaches the model in one of two ways: the user types its `/slug` in the composer, or the model asks
for it by name through the `skill` tool. The first path injects the instruction as a system message
for that one send and persists nothing about the resolution; the second returns it as the tool's
result.

The reason the subsystem exists in this shape is prompt budget. The app has a lot of behaviour it
would like to describe to the model — how to render a weather forecast, how to run a research pass,
how to offer an integration connection — and inlining all of it would make every prompt pay for
guidance most turns never use. So the prompt carries only a catalog (one `name: description` line
per enabled skill) and the model pulls the body on demand. That is why every model-facing widget
contract ships as a seeded skill rather than as prompt text, and why the `description` field is
load-bearing: it is the only thing the model sees before deciding to load the skill.

## The data model

[`skillsTable`](../../src/db/tables.ts#L202) holds `name`, `label`, `description`, `instruction`,
`enabled`, `pinned_order`, `deleted_at`, `default_hash`, `user_id`, plus a partial index on active
rows.

`name` is the **slug** — the `/token`. It is validated against the
[AgentSkills spec](https://agentskills.io/specification#name-field) by
[`validateSkillName`](../../src/dal/skills.ts#L53): 1–64 characters, lowercase `a–z`, digits and
hyphens only, no leading, trailing or doubled hyphen. The leading `/` is a chat trigger added at
display and parse time; it is never stored.

`label` is the free-text display name ("Daily Brief"). It is nullable, and rows created before the
column existed still read as `null`. Reconciliation cannot backfill them — adding `label` to the
content hash would make every legacy row look user-edited — so
[`skillDisplayName`](../../src/skills/display.ts#L26) title-cases the slug instead.

Deletes are soft: [`softDeleteSkill`](../../src/dal/skills.ts#L220) stamps `deleted_at` and nulls
`name`, `label`, `description`, `instruction` and `pinned_order`, leaving `(id, user_id,
deleted_at)` as a tombstone for PowerSync to propagate. Because the tombstone's `name` is `NULL`,
the uniqueness check in `assertNameAvailable` needs no extra `deleted_at` filter — a deleted skill's
slug is free again.

Pinning is capped at `maxPinnedSkills = 10` ([`src/dal/skills.ts:14`](../../src/dal/skills.ts#L14));
pinned skills are the chips in the composer's skills bar, ordered by `pinned_order`.

The table is part of the synced set and uses a composite primary key `(id, user_id)` so every
account can hold the seeded defaults under the same ids — see
[composite-primary-keys-and-default-data.md](./composite-primary-keys-and-default-data.md). Rows are
included in the data export ([export-format.md](./export-format.md)) and are indexed by the command
palette ([search.md](./search.md)).

## Progressive disclosure

[`shared/agent-core/skills.ts`](../../shared/agent-core/skills.ts) owns the two prompt shapes, and
`src/ai/prompt.ts` picks between them on one signal:

```ts
const skillDisclosure = supportsTools ? buildSkillListing(skills) : buildFallbackSkillDisclosure(skills)
```

([`src/ai/prompt.ts:114`](../../src/ai/prompt.ts#L114))

- [`buildSkillListing`](../../shared/agent-core/skills.ts#L102) emits the `## Skills` catalog plus
  one line telling the model to use the `skill` tool before acting on a skill, and that a `/name`
  token in the conversation means those instructions are already loaded.
- [`buildFallbackSkillDisclosure`](../../shared/agent-core/skills.ts#L87) emits the same catalog
  followed by every instruction body inline. This is the path for models that cannot call tools, and
  for those models [`selectPromptSkillDefinitions`](../../src/ai/fetch.ts#L510) narrows the set to
  widget contracts only — without tools there is no way to fetch a body later, so the inline cost is
  paid only for the skills that keep rendering correct.

The tool itself is [`createSkillTool`](../../src/skills/skill-tool.ts#L31): a one-argument AI SDK
tool that resolves an enabled skill by bare name or `/slug` and returns its `instruction`, throwing
when the name is unknown or the skill is disabled. It is registered only when the model supports
tools ([`addSkillTool`](../../src/ai/fetch.ts#L490)).

Loading a skill can also widen the turn's web-tool budget. `search` and `research` are mapped to
wider intents in [`src/ai/turn-web-budget.ts:8`](../../src/ai/turn-web-budget.ts#L8), and the
`onSkillLoaded` callback promotes the budget when the model loads either of them mid-turn
([`src/ai/fetch.ts:498`](../../src/ai/fetch.ts#L498)) — the same map the explicit `/research` token
goes through. See [chat-runtime.md](./chat-runtime.md) for how that budget is keyed and spent.

## Slash tokens

The token grammar lives in
[`skillTokenRegex`](../../src/skills/parse-skill-tokens.ts#L23): `/` followed by `[\w-]+`, matched
only when preceded by whitespace or start-of-input and terminated by whitespace or end-of-input. The
lookbehind is the important half — without it `docs/meeting-notes` or `example.com/meeting-notes`
would silently inject a skill the user never invoked. The trailing boundary excludes tokens followed
by punctuation so a sentence-final period cannot eat the last character of a slug.

Two token shapes exist, because the composer inserts human titles while the model only ever sees
slugs. [`findSkillTokens`](../../src/skills/parse-skill-tokens.ts#L102) matches **display tokens**
(`/Daily Brief`, resolved longest-first through a display-name → slug map) as well as hand-typed
**slug tokens**, and [`normalizeSkillTokensToSlugs`](../../src/skills/parse-skill-tokens.ts#L167)
rewrites the former to the latter at send time. Display names are free text and therefore not
unique, so [`buildDisplayNameToSlug`](../../src/skills/display.ts#L50) drops any name claimed by two
skills: an unresolvable token degrading to plain text beats sending the wrong skill's instructions.

Resolution runs on every send and regenerate and is not persisted — the user's text carries the
tokens forward, and a replay re-resolves against whatever the library looks like then.
[`resolveSkillTokenInstructions`](../../src/skills/resolve-skill-system-messages.ts#L22) is the
single entry point, deliberately shared by two surfaces that must not drift:
`chat-prompt-input.tsx` sums the resolved instructions into the token estimate behind the
context-overflow modal, and the send path prepends them as system messages. Every agent path calls
it — `src/ai/fetch.ts` for the classic built-in pipeline, `src/acp/built-in-adapter.ts` for the Pi
harness, and `src/chats/chat-instance.ts` for external ACP agents, which have no system channel of
their own.

In the built-in pipeline the resolved instructions land in
[`buildVolatileSystemNotes`](../../src/ai/fetch.ts#L629), after the date/time note and the voice
notes — the per-send half of the prompt, kept out of the cacheable stable half.

The composer paints tokens through an overlay
([`renderHighlightedSkillTokens`](../../src/skills/highlight-skill-tokens.tsx#L57)) that classifies
each committed token as `enabled`, `disabled` or `unknown` and offers an Enable or Create action for
the latter two via [`SkillTokenPopover`](../../src/skills/skill-token-popover.tsx). The `/` glyph is
rendered transparent rather than removed, so caret alignment against the textarea underneath holds.

## Widget contracts are skills

Five of the nine seeded defaults are not editable user content but model-facing rendering contracts
whose `instruction` is imported straight from a widget's `instructions.ts`
([`src/defaults/skills.ts:7`](../../src/defaults/skills.ts#L7)). The set of their ids is
`widgetSkillIds`, exposed as
[`isWidgetSkillId`](../../src/defaults/skills.ts#L258), and the DAL refuses to let the user break
them: `updateSkill` rejects any patch other than `enabled`, `softDeleteSkill` refuses outright, and
`setPinned` and `reorderPins` refuse to pin or move one (unpinning is allowed).

The subtler half is how their toggle state interacts with reconciliation.
[`hashSkill`](../../src/defaults/skills.ts#L22) hashes only `[name, label, description, instruction]`
for a widget id, while an editable default also hashes `enabled`, `pinnedOrder` and `deletedAt`:

```ts
const contentFields = [skill.name, skill.label, skill.description, skill.instruction]
return hashValues(
  isWidgetSkillId(skill.id) ? contentFields : [...contentFields, skill.enabled, skill.pinnedOrder, skill.deletedAt],
)
```

Reconciliation treats a hash mismatch as "the user edited this row, leave it alone". For an editable
skill that is exactly right. For a widget contract it would mean that a user who disabled the
Weather skill once could never receive a corrected weather tag contract again. Excluding the state
fields from the hash keeps contract updates flowing; the user's choice is then preserved on the other
side by `frozenFields`, which tells the reconciler to keep the existing `enabled` and `pinned_order`
when it rewrites the row
([`src/lib/reconcile-defaults.ts:642`](../../src/lib/reconcile-defaults.ts#L642)). The two mechanisms
are complementary — dropping either one loses a property.

The end-to-end recipe for exposing a new widget to the model is in
[widgets.md](../features/widgets.md#making-a-widget-model-facing); this section is the reason behind
its steps.

## The seeded defaults

[`src/defaults/skills.ts`](../../src/defaults/skills.ts) ships nine rows, seeded per user by
`reconcileDefaults` during app initialization ([app-initialization.md](./app-initialization.md)).

| Slug                  | Label               | Kind            | Ships enabled | Ships pinned |
| --------------------- | ------------------- | --------------- | ------------- | ------------ |
| `daily-brief`         | Daily Brief         | editable        | yes           | no           |
| `important-emails`    | Important Emails    | editable        | no            | no           |
| `search`              | Search              | editable        | yes           | position 0   |
| `research`            | Research            | editable        | yes           | position 1   |
| `weather`             | Weather             | widget contract | yes           | position 2   |
| `link-preview`        | Link Preview        | widget contract | yes           | no           |
| `connect-integration` | Connect Integration | widget contract | yes           | no           |
| `ask`                 | Ask                 | widget contract | yes           | no           |
| `map`                 | Map                 | widget contract | yes           | no           |

**Changing any of these requires bumping
[`defaultSkillsVersion`](../../src/defaults/skills.ts#L283).** It is the ordering signal
reconciliation uses to decide which device owns the newest defaults, so an unbumped change silently
breaks convergence across a sync group. The colocated snapshot test
([`src/defaults/skills.test.ts:43`](../../src/defaults/skills.test.ts#L43)) pins the version against
a per-row hash and fails on any content change without a matching bump. The algorithm is documented
in [reconciled-defaults.md](./reconciled-defaults.md); the short rule, and the other tables that
carry a version constant, are in [AGENTS.md](../../AGENTS.md#reconciled-defaults-and-version-bumps).

For the same reason, `label` and `description` on seeded rows are **not** localized: they are
reconciled by content hash, so translating them would make every row read as user-edited on a
device running another language.

## Skills across agent types

The built-in pipeline reads the library directly. The other two paths have to carry skills over a
wire, and both live on the same shared module.

**External ACP agents.** Thunderbolt advertises and detects a custom capability under the
`thunderbird.net/thunderbolt` ACP extension namespace
([`thunderboltAcpMetaKey`](../../shared/agent-core/skills.ts#L13)). If the agent's `initialize`
response declares `{ skills: true }` in its capability `_meta`
([`supportsWireSkills`](../../shared/agent-core/skills.ts#L39), surfaced onto the UI capability
shape at [`src/acp/acp-adapter.ts:110`](../../src/acp/acp-adapter.ts#L110)), the full skill
definitions ride along on `session/new` and `session/resume` as
[`buildWireSkillsMeta`](../../shared/agent-core/skills.ts#L50) metadata
([`src/acp/acp-adapter.ts:557`](../../src/acp/acp-adapter.ts#L557)); disclosing them to its model is
then the agent's own business — the CLI harness below reads them back with `readWireSkills`. An agent
that does not declare the capability gets `buildFallbackSkillDisclosure` injected into the session
instead
([`src/acp/acp-adapter.ts:536`](../../src/acp/acp-adapter.ts#L536)) — every body inline, because
there is no channel to fetch one later.

**The CLI.** `cli/src/acp/harness-agent.ts` is on the receiving end of that same protocol: it
declares `skillsCapabilityMeta` in its `initialize` response
([`cli/src/acp/harness-agent.ts:244`](../../cli/src/acp/harness-agent.ts#L244)) and reads the
delivered definitions with `readWireSkills` on both `session/new` and `session/resume`. It then
builds its own catalog with `buildSkillListing` and registers its own `skill` tool
([`cli/src/agent/system-prompt.ts:69`](../../cli/src/agent/system-prompt.ts#L69),
[`cli/src/agent/skill-tool.ts:19`](../../cli/src/agent/skill-tool.ts#L19)). The standalone CLI, with
no client to send it skills, gets an empty list and no `## Skills` section at all.

The slash menu in the composer merges skills with the connected agent's own ACP commands into one
list ([`SlashItem`](../../src/skills/use-slash-command.ts#L18)); commands insert their literal name
while skills insert their display title.

## Managing skills

Settings → Skills (`/settings/skills`, lazily loaded at
[`src/app.tsx:277`](../../src/app.tsx#L277)) renders `SkillsView`, whose state machine is factored
out into [`skills-view-state.ts`](../../src/skills/skills-view-state.ts) — a list plus a detail
panel that doubles as a create/edit form, with confirmation for discarding a dirty form.

Deletion and disabling both run a dependents check first
([`skills-view.tsx:78`](../../src/skills/skills-view.tsx#L78) and
[`:140`](../../src/skills/skills-view.tsx#L140)).
[`findDependents`](../../src/skills/find-dependents.ts#L18) scans every other skill's `description`
and `instruction` for a `/target` reference, with a `(?![a-z0-9-])` lookahead so `/foo` does not
match `/foo-bar`. One skill's instructions may compose another by naming its token, and the model is
told that a `/name` token means those instructions are loaded — so removing the referenced skill
leaves the referrer pointing at something that resolves to nothing. The dialog names the referrers
and lets the user decide rather than breaking them silently.

Telemetry is in [`src/skills/telemetry.ts`](../../src/skills/telemetry.ts). Every `skill_*` event
carries `sha256(user_id + ':' + skill.id)` truncated to 16 hex characters and never any authored
content — salting with the user id means the analytics pipeline cannot correlate the same skill
across accounts.

## Invariants worth knowing

- Slugs are stored bare. Any code that compares a token to a stored `name` must strip the `/`
  first — [`resolveSkill`](../../shared/agent-core/skills.ts#L119) does this for both skill tools,
  the app's and the CLI harness's.
- Token resolution is never persisted. If you need a skill's effect to survive a replay, it has to
  come from the user's text or the library, not from turn state.
- Both resolution surfaces share one helper. A change to matching semantics that only lands in one
  of them makes the context-overflow estimate disagree with what is actually sent.
- A new injected system section needs both the built-in and the ACP paths, or it vanishes when the
  user switches agents — see "What must stay in step when you change send behaviour" in
  [chat-runtime.md](./chat-runtime.md#what-must-stay-in-step-when-you-change-send-behaviour).
- Widget-contract ids are locked in the DAL, not just the UI. Reach for `updateSkill` on one and it
  throws.
- Changing a default without bumping `defaultSkillsVersion` breaks multi-device convergence.

## Tests

```bash
bun test src/skills src/defaults/skills.test.ts shared/agent-core/skills.test.ts --timeout 5000
```

`parse-skill-tokens.test.ts` covers the token grammar and the display/slug normalization,
`find-dependents.test.ts` the reference scan, `display.test.ts` the label fallback and ambiguity
rules, `skill-tool.test.ts` the tool's resolution and error paths, `skills-view-state.test.ts` the
settings state machine, `src/defaults/skills.test.ts` the version snapshot and the widget-skill
carve-out, and `shared/agent-core/skills.test.ts` the prompt builders and the ACP wire format.
