# Skills

A skill is a named, reusable block of instructions stored as a row in the synced `skills` table.

| Path         | Trigger                            | Reaches the model as               | Persisted                                    |
| ------------ | ---------------------------------- | ---------------------------------- | -------------------------------------------- |
| Slash token  | User types `/slug` in the composer | A system message for that one send | No: re-resolved on every send and regenerate |
| `skill` tool | Model asks for the skill by name   | The tool's result                  | n/a                                          |

The prompt lists one `name: description` line per enabled skill and the model pulls bodies on
demand, so a prompt pays only for the guidance a turn actually uses. `description` is all the model
sees before deciding to load, which is why every model-facing widget contract ships as a seeded
skill.

## What ships by default

[`src/defaults/skills.ts`](../../../src/defaults/skills.ts) ships nine rows, seeded per user by
`reconcileDefaults` during app initialization ([app-initialization.md](app-initialization.md)).

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

**Any change here requires bumping [`defaultSkillsVersion`](../../../src/defaults/skills.ts#L283)**,
the signal reconciliation uses to pick which device owns the newest defaults; an unbumped change
silently breaks convergence across a sync group. The snapshot test
([`src/defaults/skills.test.ts:43`](../../../src/defaults/skills.test.ts#L43)) catches it. Algorithm:
[reconciled-defaults.md](reconciled-defaults.md); other versioned tables:
[AGENTS.md](../../../AGENTS.md#reconciled-defaults-and-version-bumps).

Seeded `label` and `description` are **not** localized: they are reconciled by content hash, so a
translation reads as a user edit on a device running another language.

## How a skill is stored

[`skillsTable`](../../../src/db/tables.ts#L202) holds `name`, `label`, `description`, `instruction`,
`enabled`, `pinned_order`, `deleted_at`, `default_hash`, `user_id`, plus a partial index on active
rows.

| Field          | Rule                                                                                                                                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`         | The **slug** (the `/token`), stored bare. 1–64 characters, lowercase `a–z`, digits and hyphens, no leading, trailing or doubled hyphen ([AgentSkills spec](https://agentskills.io/specification#name-field), enforced by [`validateSkillName`](../../../src/dal/skills.ts#L53)).                                                           |
| `label`        | Free-text display name ("Daily Brief"). Nullable; rows predating the column read as `null`.                                                                                                                                                                                                                                                |
| `pinned_order` | Order of the chips in the composer's skills bar. Capped at `maxPinnedSkills = 10` ([`src/dal/skills.ts:14`](../../../src/dal/skills.ts#L14)).                                                                                                                                                                                              |
| `deleted_at`   | Soft-delete tombstone. [`softDeleteSkill`](../../../src/dal/skills.ts#L220) stamps it and nulls `name`, `label`, `description`, `instruction` and `pinned_order`. The row keeps `(id, user_id, deleted_at)` for PowerSync to propagate; with `name` `NULL`, `assertNameAvailable` needs no `deleted_at` filter and the slug is free again. |

The leading `/` is added at display and parse time, never stored. A missing `label` cannot be
backfilled (adding it to the hash would make every legacy row look user-edited), so
[`skillDisplayName`](../../../src/skills/display.ts#L26) title-cases the slug.

Composite primary key `(id, user_id)`, so every account holds the seeded defaults under one set of
ids ([composite-primary-keys-and-default-data.md](composite-primary-keys-and-default-data.md)).
Rows are in the data export ([export-format.md](export-format.md)) and indexed by the command
palette ([search.md](search.md)).

## Progressive disclosure: how the model learns a skill exists

[`shared/agent-core/skills.ts`](../../../shared/agent-core/skills.ts) owns the two prompt shapes;
`src/ai/prompt.ts` picks on one signal:

```ts
const skillDisclosure = supportsTools ? buildSkillListing(skills) : buildFallbackSkillDisclosure(skills)
```

([`src/ai/prompt.ts:114`](../../../src/ai/prompt.ts#L114))

| Builder                                                                    | Emits                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`buildSkillListing`](../../../shared/agent-core/skills.ts#L102)           | The `## Skills` catalog, plus a line telling the model to call the `skill` tool before acting on a skill and that a `/name` token means those instructions are already loaded.                                                    |
| [`buildFallbackSkillDisclosure`](../../../shared/agent-core/skills.ts#L87) | The same catalog with every instruction body inline, for models without tools. [`selectPromptSkillDefinitions`](../../../src/ai/fetch.ts#L510) narrows that set to widget contracts, since there is no way to fetch a body later. |

[`createSkillTool`](../../../src/skills/skill-tool.ts#L31) returns an enabled skill's `instruction` by
bare name or `/slug`, throwing on an unknown or disabled name. Registered only when the model
supports tools ([`addSkillTool`](../../../src/ai/fetch.ts#L490)).

`search` and `research` also widen the turn's web-tool budget: both map to wider intents in
[`src/ai/turn-web-budget.ts:8`](../../../src/ai/turn-web-budget.ts#L8), and `onSkillLoaded` promotes
the budget mid-turn ([`src/ai/fetch.ts:498`](../../../src/ai/fetch.ts#L498)) through the same map an
explicit `/research` token uses ([chat-runtime.md](chat-runtime.md)).

## How `/slug` tokens are parsed

[`skillTokenRegex`](../../../src/skills/parse-skill-tokens.ts#L23): `/` plus `[\w-]+`, matched only
after whitespace or start-of-input and terminated by whitespace or end-of-input. The lookbehind
stops `docs/meeting-notes` injecting a skill the user never invoked; the trailing boundary stops a
sentence-final period eating the last character of a slug.

The composer inserts human titles while the model sees only slugs, so
[`findSkillTokens`](../../../src/skills/parse-skill-tokens.ts#L102) matches **display tokens** (`/Daily
Brief`, resolved longest-first through a display-name → slug map) as well as hand-typed **slug
tokens**; [`normalizeSkillTokensToSlugs`](../../../src/skills/parse-skill-tokens.ts#L167) rewrites the
former at send time. Display names are not unique, so
[`buildDisplayNameToSlug`](../../../src/skills/display.ts#L50) drops any name claimed by two skills: an
unresolvable token degrading to plain text beats sending the wrong instructions.

Resolution is not persisted; a replay re-resolves against the library as it stands then.
[`resolveSkillTokenInstructions`](../../../src/skills/resolve-skill-system-messages.ts#L22) is the
single entry point, shared by two surfaces that must not drift: `chat-prompt-input.tsx` sums the
instructions into the context-overflow token estimate, and the send path prepends them as system
messages.

All three agent paths call it: `src/ai/fetch.ts` (built-in), `src/acp/built-in-adapter.ts` (Pi
harness), `src/chats/chat-instance.ts` (external ACP agents, which have no system channel). In the
built-in pipeline they land in [`buildVolatileSystemNotes`](../../../src/ai/fetch.ts#L629) after the
date/time and voice notes, in the per-send half of the prompt, kept out of the cacheable stable
half.

An overlay ([`renderHighlightedSkillTokens`](../../../src/skills/highlight-skill-tokens.tsx#L57))
classifies each committed token `enabled`, `disabled` or `unknown`, offering Enable or Create for
the latter two via [`SkillTokenPopover`](../../../src/skills/skill-token-popover.tsx). The `/` glyph is
transparent rather than removed, so caret alignment against the textarea holds.

## Why widget-contract skills are locked down

Five seeded defaults are model-facing rendering contracts whose `instruction` is imported from a
widget's `instructions.ts` ([`src/defaults/skills.ts:7`](../../../src/defaults/skills.ts#L7)). Their
ids are `widgetSkillIds`, exposed as [`isWidgetSkillId`](../../../src/defaults/skills.ts#L258).

| Operation                 | On a widget contract                            |
| ------------------------- | ----------------------------------------------- |
| `updateSkill`             | Rejects any patch other than `enabled`          |
| `softDeleteSkill`         | Refuses outright                                |
| `setPinned`/`reorderPins` | Refuse to pin or move one; unpinning is allowed |

[`hashSkill`](../../../src/defaults/skills.ts#L22) leaves `enabled`, `pinnedOrder` and `deletedAt` out
of a widget id's hash, in for an editable default's.

```ts
const contentFields = [skill.name, skill.label, skill.description, skill.instruction]
return hashValues(
  isWidgetSkillId(skill.id) ? contentFields : [...contentFields, skill.enabled, skill.pinnedOrder, skill.deletedAt],
)
```

Reconciliation reads a hash mismatch as "user edited this row, leave it alone": right for an
editable skill, but for a widget contract it would mean disabling Weather once blocks every later
fix to the weather tag contract. The user's choice survives via `frozenFields`, which keeps the
existing `enabled` and `pinned_order` when the reconciler rewrites the row
([`src/lib/reconcile-defaults.ts:642`](../../../src/lib/reconcile-defaults.ts#L642)). Dropping either
mechanism loses a property.

Recipe for a new model-facing widget:
[widgets.md](../widgets.md#making-a-widget-model-facing).

## How skills reach each agent type

| Agent                                           | How skills arrive                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------- |
| Built-in pipeline                               | Reads the library directly                                                  |
| External ACP agent declaring `{ skills: true }` | Full definitions ride `session/new` and `session/resume` as `_meta`         |
| External ACP agent without the capability       | `buildFallbackSkillDisclosure` injected into the session, every body inline |
| CLI harness                                     | Reads the delivered definitions back off the same wire protocol             |
| Standalone CLI                                  | No client to send any: empty list, no `## Skills` section at all            |

Both wire paths live on [`shared/agent-core/skills.ts`](../../../shared/agent-core/skills.ts).

**External ACP agents.** The capability sits under the `thunderbird.net/thunderbolt` ACP extension
namespace ([`thunderboltAcpMetaKey`](../../../shared/agent-core/skills.ts#L13)), declared `{ skills:
true }` in the capability `_meta` of the agent's `initialize` response
([`supportsWireSkills`](../../../shared/agent-core/skills.ts#L39), surfaced onto the UI capability
shape at [`src/acp/acp-adapter.ts:110`](../../../src/acp/acp-adapter.ts#L110)). Definitions ride as
[`buildWireSkillsMeta`](../../../shared/agent-core/skills.ts#L50) metadata
([`src/acp/acp-adapter.ts:557`](../../../src/acp/acp-adapter.ts#L557)); disclosing them to its model is
the agent's business. Without the capability the fallback disclosure goes into the session
([`src/acp/acp-adapter.ts:536`](../../../src/acp/acp-adapter.ts#L536)).

**The CLI.** `cli/src/acp/harness-agent.ts` declares `skillsCapabilityMeta` in its `initialize`
response ([`harness-agent.ts:244`](../../../cli/src/acp/harness-agent.ts#L244)), reads definitions with
`readWireSkills` on `session/new` and `session/resume`, then builds its own catalog with
`buildSkillListing` and registers its own `skill` tool
([`cli/src/agent/system-prompt.ts:69`](../../../cli/src/agent/system-prompt.ts#L69),
[`cli/src/agent/skill-tool.ts:19`](../../../cli/src/agent/skill-tool.ts#L19)).

The composer's slash menu merges skills with the agent's ACP commands
([`SlashItem`](../../../src/skills/use-slash-command.ts#L18)); commands insert their literal name,
skills their display title.

## Managing skills in settings

Settings → Skills (`/settings/skills`, lazy at [`src/app.tsx:277`](../../../src/app.tsx#L277)) renders
`SkillsView`; its state machine, [`skills-view-state.ts`](../../../src/skills/skills-view-state.ts), is
a list plus a detail panel doubling as a create/edit form, with confirmation on discarding a dirty
form.

Deletion and disabling run a dependents check first
([`skills-view.tsx:78`](../../../src/skills/skills-view.tsx#L78),
[`:140`](../../../src/skills/skills-view.tsx#L140)).
[`findDependents`](../../../src/skills/find-dependents.ts#L18) scans every other skill's `description`
and `instruction` for a `/target` reference, with a `(?![a-z0-9-])` lookahead so `/foo` does not
match `/foo-bar`. Skills compose by naming each other's tokens, so the dialog names the referrers
rather than breaking them silently.

[`src/skills/telemetry.ts`](../../../src/skills/telemetry.ts): every `skill_*` event carries
`sha256(user_id + ':' + skill.id)` truncated to 16 hex characters, never authored content. The
user-id salt stops analytics correlating a skill across accounts.

## Invariants worth knowing

- Slugs are stored bare; strip the `/` before comparing a token to a stored `name`.
  [`resolveSkill`](../../../shared/agent-core/skills.ts#L119) does it for both skill tools.
- Token resolution is never persisted. Anything that must survive a replay comes from the user's
  text or the library, not turn state.
- Both resolution surfaces share one helper; changing matching semantics in only one makes the
  context-overflow estimate disagree with what is sent.
- A new injected system section needs both the built-in and the ACP paths, or it vanishes when the
  user switches agents
  ([chat-runtime.md](chat-runtime.md#what-must-stay-in-step-when-you-change-send-behaviour)).
- Widget-contract ids are locked in the DAL, not just the UI. `updateSkill` on one throws.
- Changing a default without bumping `defaultSkillsVersion` breaks multi-device convergence.

## Tests

```bash
bun test src/skills src/defaults/skills.test.ts shared/agent-core/skills.test.ts --timeout 5000
```

| File                               | Covers                                    |
| ---------------------------------- | ----------------------------------------- |
| `parse-skill-tokens.test.ts`       | Token grammar, display/slug normalization |
| `find-dependents.test.ts`          | The reference scan                        |
| `display.test.ts`                  | Label fallback and ambiguity rules        |
| `skill-tool.test.ts`               | The tool's resolution and error paths     |
| `skills-view-state.test.ts`        | The settings state machine                |
| `src/defaults/skills.test.ts`      | Version snapshot, widget-skill carve-out  |
| `shared/agent-core/skills.test.ts` | Prompt builders, ACP wire format          |
