# Model Profiles Architecture

## The Problem

Before this migration, model-specific behavior lived in 14+ TypeScript files under `src/ai/prompts/vendors/`:

```
vendors/
  defaults.ts                          # base config (temp, maxSteps, etc.)
  openai/
    config.ts                          # { systemMessageMode: 'developer' }
    global.ts                          # "After calling tools, you MUST write..."
    chat.ts                            # citation addendum for chat mode
    search.ts                          # widget:link-preview format enforcement
    research.ts                        # citation count enforcement
    nudges.ts                          # GPT-OSS-specific nudge wording
    models/gpt-oss-120b/config.ts      # temp: 0.3, maxSteps: 8, maxAttempts: 4
  mistral/
    global.ts                          # citation rule + link preview workflow
    chat.ts                            # "MANDATORY: Every fact..."
    search.ts                          # content quality verification
    research.ts                        # citation count check
    nudges.ts                          # Mistral-specific nudge wording
    citation-reinforcement.ts          # system prompt appendix after tool calls
```

These were resolved at runtime through a 3-layer merge: `defaults → vendor → model`, with prompt overrides concatenated per-mode. The result: `fetch.ts` was littered with `model.vendor === 'openai'` and `model.vendor === 'mistral'` conditionals.

**Why this was a problem:**
- Custom models (user-added via OpenRouter, local Ollama, etc.) got zero tuning
- The extension marketplace couldn't ship model profiles as data
- Adding a new model required touching multiple code files

## The Solution: `model_profiles` Table

One row per model. Every behavioral override is a nullable column — `null` means "use the code default."

### Schema

```sql
CREATE TABLE model_profiles (
  -- Identity (PK + FK)
  model_id          TEXT PRIMARY KEY REFERENCES models(id),

  -- Inference config (numeric)
  temperature       REAL,           -- 0.0-1.0, null = 0.2
  max_steps         INTEGER,        -- tool-call loop limit, null = 20
  max_attempts      INTEGER,        -- empty response retries, null = 2
  nudge_threshold   INTEGER,        -- steps before preventive nudge, null = 6

  -- Provider behavior (flags)
  use_system_message_mode_developer  INTEGER DEFAULT 0,  -- 0/1 flag

  -- Prompt text overrides (appended to base prompt sections)
  tools_override              TEXT,  -- after "# Tools" section
  link_previews_override      TEXT,  -- after "## Link Previews" subsection
  chat_mode_addendum          TEXT,  -- after "# Active Mode" when mode=chat
  search_mode_addendum        TEXT,  -- after "# Active Mode" when mode=search
  research_mode_addendum      TEXT,  -- after "# Active Mode" when mode=research

  -- Citation reinforcement (system prompt appended after tool calls)
  citation_reinforcement_enabled  INTEGER DEFAULT 0,
  citation_reinforcement_prompt   TEXT,

  -- Nudge message overrides (injected during agentic loop)
  nudge_final_step          TEXT,   -- last step, tools disabled
  nudge_preventive          TEXT,   -- mid-loop "wrap it up" hint
  nudge_retry               TEXT,   -- after empty response
  nudge_search_final_step   TEXT,   -- same three, but for search mode
  nudge_search_preventive   TEXT,
  nudge_search_retry        TEXT,

  -- Provider-specific SDK options (JSON blob)
  provider_options    TEXT,          -- e.g. {"systemMessageMode":"developer"}

  -- Reconciliation
  default_hash        TEXT,         -- for detecting user modifications
  deleted_at          INTEGER       -- soft delete
);
```

### How Overrides Flow Into the Prompt

The base system prompt in `prompt.ts` has **injection points** — spots where profile text gets appended:

```
You are an executive assistant using the **{modelName}** model...

# Tools
Your training data is outdated—search first, answer second.
...
{toolsOverride}                          ← profile.toolsOverride

## Link Previews
• Aggregate pages are for DISCOVERY ONLY
...
{linkPreviewsOverride}                   ← profile.linkPreviewsOverride

# Active Mode (follow these instructions)
{modeSystemPrompt}                       ← from modes table
{modeAddendum}                           ← profile.chatModeAddendum / searchModeAddendum / researchModeAddendum
```

The key design: overrides are **additive**. They append text to the base prompt; they never replace it. This means the base prompt stays in code (same for all models), while per-model tuning lives in the database.

### How Nudges Work

During inference, `fetch.ts` runs an agentic loop (tool calls → responses → more tool calls). At key moments, "nudge" messages are injected as user messages to steer the model:

| Nudge | When | Purpose |
|-------|------|---------|
| `finalStep` | Last step (tools disabled) | "Respond now with what you have" |
| `preventive` | After N tool calls | "You have enough, start writing" |
| `retry` | After empty response | "Your last response was blank, try again" |

Each has a search-mode variant (`nudgeSearchFinalStep`, etc.) because search mode needs `<widget:link-preview>` tags instead of `[N]` citations.

The profile provides per-model nudge text. Null = use code defaults. This matters because:
- **GPT-OSS** needs soft language ("You must write your final answer now") — aggressive ALL-CAPS triggers the "acknowledgment trap" (empty responses)
- **Mistral** needs citation reminders in every nudge ("cite every fact with [N]") because it tends to write responses without citations
- **Sonnet** works fine with the generic defaults

### Citation Reinforcement

Mistral has a unique quirk: its native citation system uses structured `ReferenceChunk` objects, but through vLLM's OpenAI-compatible API, this mechanism is unavailable. The model sometimes falls back to training behavior (no text-based citations).

The fix: after tool calls, **append extra text to the system prompt** via the AI SDK's `prepareStep({ system })` override. This is the highest-authority channel for instruction-tuned models.

```typescript
// In fetch.ts prepareStep callback:
const citationSystem = profile?.citationReinforcementEnabled && hadToolCallSteps
  ? systemPrompt + (profile.citationReinforcementPrompt ?? '')
  : undefined
```

Currently only Mistral uses this (`citationReinforcementEnabled: 1`), but any future model can enable it by setting the flag and providing prompt text.

### Seed Data Mapping

| Field | GPT-OSS | Mistral | Sonnet |
|-------|---------|---------|--------|
| temperature | 0.3 | 0.2 | 0.2 |
| maxSteps | 8 | 20 | 20 |
| maxAttempts | 4 | 2 | 2 |
| nudgeThreshold | 5 | 6 | 6 |
| useSystemMessageModeDeveloper | 1 | 0 | 0 |
| toolsOverride | "After calling tools..." | "CITATION RULE..." | null |
| linkPreviewsOverride | null | "SIMPLIFIED LINK PREVIEW..." | null |
| chatModeAddendum | "Each distinct fact..." | "MANDATORY: Every fact..." | null |
| searchModeAddendum | "CRITICAL: Your response..." | "Before responding, verify..." | null |
| researchModeAddendum | tools + mode combined | "CITATION CHECK..." | null |
| citationReinforcementEnabled | 0 | 1 | 0 |
| citationReinforcementPrompt | null | `<citation-format>...</citation-format>` | null |
| All 6 nudge fields | Custom GPT-OSS nudges | Custom Mistral nudges | null (defaults) |
| providerOptions | `{systemMessageMode: 'developer'}` | null | null |

### The Null-Means-Default Pattern

Sonnet's profile is almost entirely `null`. This is intentional:

```typescript
// In fetch.ts:
const modelTemperature = profile?.temperature ?? DEFAULT_TEMPERATURE  // 0.2
const maxSteps = profile?.maxSteps ?? DEFAULT_MAX_STEPS              // 20

// In step-logic.ts:
const hasNudgeOverrides = profile.nudgeFinalStep || profile.nudgePreventive || profile.nudgeRetry
if (hasNudgeOverrides) {
  return { finalStep: profile.nudgeFinalStep ?? nudgeMessages.finalStep, ... }
}
return nudgeMessages  // code-level defaults
```

Benefits:
- **Minimal storage** — only store what differs from defaults
- **Safe upgrades** — when we improve the default nudge text, all null-profile models get it automatically
- **User customization** — a user can override just `temperature` without touching nudges

### Reconciliation (Auto-Update on App Start)

The `reconcileDefaultsForTable()` function runs on every app start:

1. For each default profile, check if the row exists in DB
2. If missing → insert it (new model added in a code update)
3. If present and `defaultHash` matches current content → user hasn't modified it → safe to update with new defaults
4. If `defaultHash` differs → user customized this profile → leave it alone

This means prompt improvements ship as code updates, automatically propagate to unmodified profiles, and never overwrite user customizations.

### Cascade Behavior

- `createModel()` → auto-creates default profile (if seed data exists for that model ID)
- `deleteModel()` → soft-deletes the profile before soft-deleting the model
- FK constraint with `ON DELETE CASCADE` provides a safety net at the DB level
