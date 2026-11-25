# Widgets

Widgets are interactive UI components the AI embeds in responses using XML-like tags.

## Table of Contents

- [Quick Start: Adding a Widget](#quick-start-adding-a-widget)
- [Architecture Overview](#architecture-overview)
- [Shipped Widgets](#shipped-widgets)
- [How Widgets Work](#how-widgets-work)
- [Message Cache System](#message-cache-system)
- [Interactive Widgets](#interactive-widgets)
- [Privacy & Security via Proxy](#privacy--security-via-proxy)
- [Prompt Engineering for Widgets](#prompt-engineering-for-widgets)
- [Best Practices](#best-practices)
- [Testing](#testing)

## Quick Start: Adding a Widget

A display-only widget (rendered from a tag something else produced) is one directory plus one entry in
`src/widgets/index.ts`. A widget the **model** emits also needs an `instructions.ts` and a seeded skill
carrying it: see [Making a widget model-facing](#making-a-widget-model-facing).

### Widget File Structure

```text
src/widgets/my-widget/
  ├── schema.ts          # Zod schema + auto-generated parser
  ├── widget.tsx         # Main widget component (fetches & displays)
  ├── index.ts           # Public exports
  ├── instructions.ts    # Model-facing instructions (only for model-emitted widgets)
  └── stories.tsx        # Storybook stories (optional)
```

`instructions.ts` is optional: `citation` and `document-result` ship without one because no seeded skill
surfaces them to the model.

Optional files for more complex widgets:

| File                     | Purpose                                                |
| ------------------------ | ------------------------------------------------------ |
| `constants.ts`           | sessionStorage keys, event names, config values        |
| `lib.ts` / `lib.test.ts` | Utility functions and types                            |
| `display.tsx`            | Presentation component, separate from the fetching one |
| `schema.test.ts`         | Schema parsing tests                                   |

### Step 1: Create Widget Directory

```bash
mkdir -p src/widgets/my-widget
```

### Step 2: Create Required Files

#### `src/widgets/my-widget/instructions.ts` (model-emitted widgets only)

The registry does not read this string; it reaches the model as a seeded skill.

```typescript
export const instructions = `## My Widget
<widget:my-widget attribute="value" />
Brief description of what it does
Example: <widget:my-widget attribute="example" />`
```

#### `src/widgets/my-widget/schema.ts`

`createParser(schema)` auto-generates the parser from the schema.

```typescript
import { createParser } from '@/lib/create-parser'
import { z } from 'zod'

export const schema = z.object({
  widget: z.literal('my-widget'),
  args: z.object({
    attribute: z.string().min(1, 'Attribute is required'),
  }),
})

export type MyWidget = z.infer<typeof schema>

/** Shape of the data this widget caches */
export type CacheData = {
  // Example: { title: string; description: string }
}

export const parse = createParser(schema)
```

#### `src/widgets/my-widget/widget.tsx`

```typescript
import { useMessageCache } from '@/hooks/use-message-cache'

type MyWidgetProps = {
  attribute: string
  messageId: string
}

export const MyWidget = ({ attribute, messageId }: MyWidgetProps) => {
  const { data, isLoading, error } = useMessageCache({
    messageId,
    cacheKey: ['myWidget', attribute],
    fetchFn: async () => {
      // Fetch your data here
      return { /* ... */ }
    },
  })

  if (isLoading) return <div>Loading...</div>
  if (error) return <div>Error: {error.message}</div>
  if (!data) return null

  return <div>{/* Your widget UI */}</div>
}
```

#### `src/widgets/my-widget/index.ts`

```typescript
export { MyWidget, MyWidget as Component } from './widget'
export { instructions } from './instructions' // model-emitted widgets only
export { parse, schema } from './schema'
export type { CacheData, MyWidget as MyWidgetType } from './schema'
```

Export the main component under both its own name and `Component`, or the registry cannot auto-wire it.

Optionally export a `Skeleton`. The registry collects it into `widgetSkeletons` and the parser renders it as
soon as the opening tag appears (see [Streaming Support](#6-streaming-support)); `src/widgets/map/index.ts`
does this with `MapWidgetSkeleton as Skeleton`.

#### `src/widgets/my-widget/constants.ts` (optional)

Co-locate widget-specific constants: shared event names, magic strings, config values. Use camelCase, and
descriptive function names for dynamic keys. `connect-integration` uses these for OAuth retry coordination,
importing them in both the widget component and the chat state handler:

```typescript
// src/widgets/connect-integration/constants.ts
export const oauthRetryFlag = 'oauth_trigger_retry'
export const oauthRetryEvent = 'oauth-retry-trigger'
export const getOAuthWidgetKey = (messageId: string, key: 'provider' | 'completed') =>
  `oauth_widget_${messageId}_${key}`
```

### Step 3: Register in Central Registry

Edit `src/widgets/index.ts`:

```typescript
import * as linkPreview from './link-preview'
import * as myWidget from './my-widget' // Add import
import * as weatherForecast from './weather-forecast'

export { LinkPreview, LinkPreviewSkeleton, LinkPreviewWidget } from './link-preview'
export { MyWidget } from './my-widget' // Add export
export { WeatherForecastWidget } from './weather-forecast'

// The parser, schema, component and skeleton wire themselves from this
export const widgetRegistry = [
  { name: 'weather-forecast' as const, module: weatherForecast },
  { name: 'link-preview' as const, module: linkPreview },
  { name: 'my-widget' as const, module: myWidget }, // Add your widget
] as const

// The cache-data union is hand-maintained; add your widget if it caches anything
export type WidgetCacheData = linkPreview.CacheData | weatherForecast.CacheData | myWidget.CacheData
```

### Done

Registration wires the Zod schema (`widgetSchemas`), the parser (`widgetParsers`), the component
(`widgetComponents`) and the streaming skeleton if the module exports one (`widgetSkeletons`). No need to
touch `widget-types.ts`, `widget-parser.ts`, `widget-renderer.tsx`, or `db/tables.ts`.

Two things are **not** automatic: the `WidgetCacheData` union above, and the model-facing instructions.

### Making a Widget Model-Facing

Nothing concatenates widget instructions into the system prompt. Model-facing contracts ship as **seeded
default skills**: the prompt carries only each skill's name and description (`buildSkillListing`,
`shared/agent-core/skills.ts`), and the model loads the rest on demand with the `skill` tool, so adding a
widget does not lengthen every prompt.

To expose a widget to the model, edit `src/defaults/skills.ts`:

1. Import the widget's `instructions` and declare a `Skill` row whose `instruction` is that string. Write the
   `description` as a "use this skill when …" sentence: it is all the model sees before loading the skill.
2. Add the skill's id to `widgetSkillIds`. Widget skills hash only their content fields, so a user disabling
   or unpinning the skill cannot block a later contract update (`hashSkill`, same file).
3. Add the row to `defaultSkills`.
4. Bump `defaultSkillsVersion`. It is the ordering signal reconciliation uses across devices, and
   `src/defaults/skills.test.ts` pins a snapshot that fails on any content change without a matching bump.

`citation` and `document-result` have no skill by design: the prompt forbids emitting `<widget:citation>`
(`src/ai/prompt.ts`), and `document-result` belongs to a future document-search mode that will carry its own
guidance. `src/defaults/skills.test.ts` asserts both stay unseeded.

### Real-World Examples

`src/widgets/link-preview/` is the simple shape: schema, `widget.tsx`, `display.tsx`, `utils.ts` +
`utils.test.ts`, `widget.test.tsx`, `stories.tsx`. `src/widgets/weather-forecast/` adds the optional files:
`fetch-forecast.ts` + `fetch-forecast.test.ts`, `lib.ts` + `lib.test.ts`, `display.tsx` + `display.test.tsx`
(snapshots in `__snapshots__/`), and `display.stories.tsx`.

---

## Architecture Overview

Four layers:

| Layer     | Location                                  | Role                                    |
| --------- | ----------------------------------------- | --------------------------------------- |
| Parsing   | `src/ai/widget-parser.ts`                 | Extracts widget tags from LLM responses |
| Types     | `src/ai/widget-types.ts`                  | Widget schemas via Zod                  |
| Rendering | `src/components/chat/widget-renderer.tsx` | Maps widgets to React components        |
| Widgets   | `src/widgets/`                            | Individual implementations              |

```text
src/widgets/
├── index.ts                    # Central registry and exports
├── ask/
├── citation/
├── connect-integration/
├── document-result/
├── link-preview/
├── map/
└── weather-forecast/
    ├── index.ts                # Widget exports
    ├── instructions.ts         # Model-facing instructions
    ├── schema.ts               # Zod schema + parse function
    ├── widget.tsx              # Reads the unit setting, drives the cache
    ├── display.tsx             # Presentation component
    ├── fetch-forecast.ts       # Open-Meteo geocoding + forecast
    ├── lib.ts                  # Utilities and types (convertTemperature, getWeatherMetadata)
    ├── lib.test.ts             # Unit tests
    └── stories.tsx             # Storybook stories
```

### File Naming Conventions

- **Directory names**: kebab-case (`weather-forecast`, `link-preview`)
- **Component files**: `widget.tsx`
- **Instructions file**: `instructions.ts` when present, only for model-emitted widgets
- **Schema file**: `schema.ts`, holding the Zod schema and the auto-generated parser
- **Index file**: `index.ts`, exporting component, instructions, and schema
- **Test files**: source file name plus `.test.ts` (`lib.test.ts`)
- **Story files**: `stories.tsx`
- **Variable names**: lowercase (`instructions`, `parse`, `widgetRegistry`)
- **Export names**: PascalCase (`WeatherForecastWidget`, `LinkPreviewWidget`)

### Central Registry Pattern

The four lookup tables derive from `widgetRegistry` in `src/widgets/index.ts`:

```typescript
export const widgetParsers = widgetRegistry.map((widget) => ({
  tagName: widget.name,
  parse: widget.module.parse,
}))

export const widgetSchemas = widgetRegistry.map((widget) => widget.module.schema)

export const widgetComponents = Object.fromEntries(
  widgetRegistry.map((widget) => [widget.name, widget.module.Component]),
)

// Only widgets that export a `Skeleton` appear here
export const widgetSkeletons = Object.fromEntries(
  widgetRegistry
    .map((widget) => [widget.name, (widget.module as { Skeleton?: ComponentType }).Skeleton] as const)
    .filter((entry): entry is readonly [WidgetName, ComponentType] => Boolean(entry[1])),
)
```

Instructions are **not** derived here (see [Making a widget model-facing](#making-a-widget-model-facing)).
`WidgetCacheData`, the union the message-cache column is typed against, is written out by hand at the bottom
of the same file.

## Shipped Widgets

Seven widgets are registered in `src/widgets/index.ts`. Five are model-facing: each one's `instructions.ts` is
seeded as a skill in `src/defaults/skills.ts`, so the model only loads the contract when it needs it.

| Widget                | Tag args                                               | Seeded skill        | Notes                                                |
| --------------------- | ------------------------------------------------------ | ------------------- | ---------------------------------------------------- |
| `weather-forecast`    | `location`, `region`, `country`                        | Weather (pinned)    | Fetches Open-Meteo directly from the client          |
| `link-preview`        | `url`, `source`                                        | Link Preview        | Metadata via `POST /v1/preview`                      |
| `map`                 | `data` (GeoJSON), `title`                              | Map                 | Exports a streaming `Skeleton` (so does `ask`)       |
| `ask`                 | `mode`, `prompt`, `options`, `explanation`, `optional` | Ask                 | Writes the user's answer back into the message cache |
| `connect-integration` | `provider`, `service`, `reason`, `override`            | Connect Integration | Caches `isHidden` so it disappears once connected    |
| `citation`            | `sources`                                              | None                | The prompt forbids the model from emitting the tag   |
| `document-result`     | `name`, `fileId`, `snippet`, `score`                   | None                | Reserved for a future document-search mode           |

**`weather-forecast`** geocodes with Open-Meteo, then fetches the daily forecast, both from the browser
(`fetch-forecast.ts`). Geocoding always asks in English: the `region`/`country` the model supplies are usually
English and a localized response would match nothing. The winning place name is re-resolved in the UI locale
afterwards, which is why the locale is part of the cache key.

**`link-preview`** renders instantly from search-result metadata when the tag carries a `source` index, and
fetches metadata otherwise.

**`map`** takes a GeoJSON `FeatureCollection` as a JSON string, refined in `schema.ts` through
`parseFeatureCollection` so a malformed collection fails validation instead of rendering an empty map. Points,
lines and polygons (plus `Multi*` variants) are styled per the simplestyle-spec.

**`ask`** has four modes, which the instructions tell the model to pick by intent. `single`/`multiple` are for
teaching or testing: they designate a correct answer and are graded client-side. `choice`/`choices` are for a
decision or input: they have no correct answer and always offer "Other…". `optional="true"` makes a question
skippable; any other value reads as not optional. Legacy `free` is still parsed for historical messages but no
longer authored. See [Interactive Widgets](#interactive-widgets).

A `single`/`multiple` with no option marked `isCorrect` has nothing to grade against: grading it would mark every
pick wrong. `askDataOf` (`src/widgets/ask/group.ts`) therefore shows it as `choice`/`choices`, so rendering,
"Other…", the button labels, the review and the model note all treat it as ungraded, and a pick saves with
`matched: null`. It keeps the authored mode as `authoredMode`, which `askStorageKey` hashes, so answers saved
before the rule still restore. The instructions also tell the model that every graded question must mark its
right option(s), and to use `choice`/`choices` when it cannot say which is right.

**`connect-integration`** shows only when the user asks for email or calendar and the matching Google or
Microsoft tools are unavailable; its instructions list the tool names to check first.

**`citation`** renders a `CitationBadge` from a JSON or base64 `sources` attribute and declares
`CacheData = never`. The model is told to cite with inline `[N]` markers instead (`src/ai/prompt.ts`), so the
widget only serves content that already carries the tag.

**`document-result`** surfaces one source document inline. The future Document Search mode that emits it
will carry the guidance in its own mode prompt.

## How Widgets Work

### 1. LLM Response with Widget Tags

```text
Here's the weather for Seattle:

<widget:weather-forecast location="Seattle" region="Washington" country="United States" />
```

### 2. Parsing

`parseContentParts()` splits the response into text and widget parts:

```typescript
const contentParts = parseContentParts(message.text)
// Returns: [
//   { type: 'text', content: "Here's the weather for Seattle:" },
//   { type: 'widget', widget: { widget: 'weather-forecast', args: {...} } }
// ]
```

### 3. Rendering

```typescript
{contentParts.map((part, index) => {
  if (part.type === 'text') {
    return <StreamingMarkdown content={part.content} />
  }
  return <WidgetRenderer widget={part.widget} messageId={messageId} />
})}
```

### 4. Widget Component

Each component handles its own fetching:

```typescript
import { fetchWeatherForecast } from './fetch-forecast'

export const WeatherForecastWidget = ({ location, region, country, messageId }) => {
  const { temperatureUnit } = useSettings({ temperature_unit: 'c' })
  const locale = useActiveLocale()
  const { data, error } = useMessageCache({
    messageId,
    // The unit is in the key so a unit change refetches; the locale is in it because
    // the cached payload holds an already-resolved place name.
    cacheKey: ['weatherForecast', location, region, country, temperatureUnit.value, locale],
    // Gate the fetch until the setting has loaded, so the first request already
    // asks for the right unit.
    enabled: !temperatureUnit.isLoading,
    fetchFn: async () =>
      fetchWeatherForecast({
        location,
        region,
        country,
        days: 6,
        temperatureUnit: temperatureUnit.value === 'f' ? 'f' : 'c',
        locale,
      }),
  })

  if (error) return <ErrorState />
  if (!data) return <Skeleton />
  return <WeatherForecast {...data} />
}
```

`fetchWeatherForecast` (`src/widgets/weather-forecast/fetch-forecast.ts`) is the canonical frontend-direct
external fetch (see the proxy exception below).

## Message Cache System

`useMessageCache` gives widgets three things:

- **Instant display on revisit.** A cached widget reads from the local database instead of refetching.
- **Offline support.** The payload is stored in SQLite alongside the message.
- **Deduplication.** Two identical tags in one message share one fetch.

```typescript
// Database shape
chatMessagesTable = {
  id: string
  content: string
  cache: {
    'linkPreview/https://example.com': { title, description, image },
    'weatherForecast/Seattle/WA/USA': { temperature, forecast, ... }
  }
}
```

### How to Use useMessageCache

```typescript
type UseMessageCacheOptions<T> = {
  messageId: string // Required: identifies which message owns this cache
  cacheKey: string[] // Required: unique key for this data (e.g., ['linkPreview', url])
  fetchFn: () => Promise<T> // Required: function to fetch data if not cached
  enabled?: boolean // Optional: gate the fetch, defaults to true
}

const { data, isLoading, error } = useMessageCache<MyDataType>({
  messageId: message.id,
  cacheKey: ['myWidget', param1, param2],
  fetchFn: async () => fetchMyData(param1, param2),
})
```

Cache keys must be deterministic and include every parameter affecting the data. camelCase namespace first:

- ✅ `['linkPreview', url]`, `['weatherForecast', location, region, country]`
- ❌ `['link-preview', url]`, `['LinkPreview', url]`

`enabled` defers the fetch until a dependency resolves. The weather widget waits on the `temperature_unit`
setting so the first fetch already knows which unit to request, rather than firing twice.

## Interactive Widgets

Most widgets are one-way: parse a tag, fetch, display. `ask` is the exception; copy its pattern for any
widget the user answers.

Asks that sit back to back in one message (only whitespace between them) render as one wizard:
`groupAskSequences` (`src/widgets/ask/group.ts`, called from `text-part.tsx`) folds the run into an
`AskSequence`, which shows one question at a time under a `‹ Question N of M ›` step control. ‹ goes back; ›
moves on once the current step is answered.

A graded `single` is graded on the tap. A double tap still grades once. Every other mode shows the pick first,
highlighted and changeable, and commits it on the card's action button. A graded `multiple` is picked, then
graded on Submit. An ungraded `choice` or `choices` step's button reads Next when the step has a step after it,
and one press saves the answer and moves on; on the last step, or a lone ask, it reads Submit. In `choice`,
"Other…" is one of the choices, so picking it replaces the option pick, and the other way round.

For 400 ms after a step is reached by navigating (`navigatedAt` in the sequence reducer, taken in the click
handler), its card ignores taps, Submit and Skip. Without that window, the second click of a double click on Next
could land on the new card and grade a `single` or press its Skip. `useAskState` compares `Date.now()` with
`ignoreAnswersUntil` in its handlers, so no effect or timer is involved.

Every card has one action row at the bottom, after the explanation and the live region, so the button stays put
as feedback appears above it. The row holds Skip (when offered) and a single primary button: Submit or Next
while there is something to commit, otherwise Next, which navigates, once the step is answered and has a step
after it. "See all answers" is a separate button below it.

A graded step keeps its feedback on screen until the user moves on, and never auto-advances. The colours of a
wrong answer show the right one, which is the point, and a timer would take them away at a pace the user does
not set. Either way, focus moves to the new prompt, which is described by its step label. The wizard opens on
the first unanswered step. While the message is still streaming it shows a skeleton, so the user cannot finish
before every question has arrived. A lone ask is a one-step sequence, with no step control.

Going back shows a graded step read-only, its result still showing. On a revisited ungraded step, › is disabled
while the selection differs from the saved answer: it would move on and drop the edit. The button under the
options saves it and moves on; ‹ still discards it. An ungraded step stays editable while
another ask in the message is still open, and an edit overwrites the step's cache entry. Once every ask in the
message is answered, every answer locks, ungraded ones included, and stays locked after a reload. By then the
answers have gone out, gone into the composer, or failed to send (Try again resends them), so a change would
never reach the model. Answered asks also lock once a later message exists in the thread (`hasReply`, from
`chat-messages.tsx` through `AssistantMessage` and `TextPart`), even if some of the message's asks are still
open. Those open asks stay answerable, but the submit that completes such a message saves the answer and
does not send, and shows no send note. A send would start a new turn over a reply that may still be
streaming, and post a stale turn at the bottom of the thread. The model learns the answer from the ask note
on the user's next send. An "Other…" answer is still handed to the composer, since filling it sends nothing:
the user finishes the answer and sends it themselves. A message's own quiz cannot be answered while that message
streams, since it shows a placeholder until then. A locked card always shows the saved answer, not a selection
left pending when it locked. A question the
model marked `optional` offers Skip when the message holds more than one ask. A skip counts as an answer, and a
skipped graded question can still be answered while another ask is open. Going back to a skipped question
doesn't block moving on: it counts as edited only once something is picked, and that pick then replaces the
skip.

A graded answer is announced through a polite live region ("Matches the answer" / "Doesn't match the answer"),
and each option row exposes its selected state with `aria-pressed`. Answering locks the options, which would
drop focus to the page, so focus moves to the Next button under the answer (or to the prompt on the last step,
from where Tab reaches "See all answers"). The keyboard then carries on forward, with no tabbing back to the
header.

Once the answers lock (every ask in the message answered), a multi-step sequence offers a "See all answers"
button that opens a review: each prompt, the answer given (or "Skipped", or a pointer to the message for
"Other…"), a match marker for graded steps, and the explanation. A locked sequence opens straight on the review
on mount (reload, history). The review has no way back, so it waits for the message rather than the sequence: a
finished group in a message whose other questions are still open keeps its ‹ › steps, so its answers stay
reachable.

Text between asks, or a tool call that splits the message into several text parts, makes separate sequences,
but the send rule is per message (`collectMessageAsks` in `src/widgets/ask/message-asks.ts` gathers the
asks of every text part): the submit that leaves every ask in the message answered sends one user turn with all of them (`turnTextForAnswers`), in message
order. That is the chosen text for a message with one ask, and one numbered `prompt — answer` line per
question otherwise. A skipped question keeps its line, answered "skipped", so the numbers always follow the
questions. The word is English because the turn is model-facing; the "Other…" draft in the composer, which
the user sends as their own message, uses the localized word. Earlier submits send nothing. Once every
ask is answered, further clicks change nothing either. The sequence checks the query cache synchronously, so a second click in the
same frame, say on another option of the last `choice`, changes nothing.

That turn is a **hidden user message**: `sendMessage({ text, metadata: { askAnswers: true } })`. The model gets
a turn and replies with feedback as usual, but the transcript never renders it (`isAskAnswersMessage`,
checked in `chat-messages.tsx`). The user should not see their answers come back as text they typed; the card
(its sent note and its review) is the visible record. The flag rides in `chat_messages.metadata`, which is
already synced and end-to-end encrypted, so it needs no schema or sync change. The message still counts as the
thread's last message, so the card locks (`hasReply`) and the reply shows as pending. A few readers treat it
differently:

- It hosts no share action.
- Sending it scrolls to the bottom, where the card is, instead of pinning a bubble that does not exist.
- `/skill` tokens are not resolved from it.
- Search leaves it out (`hiddenWhen` on the message entity in `src/search/registry.ts`).
- Debug transcripts keep it, flagged `askAnswers: true` on the turn.

The model-facing history keeps it unchanged. An older app version on another device renders it as an ordinary
bubble; that is accepted. Chat export (`src/dal/export.ts`) keeps the flag, since `shareableMetadata` strips only debug and MCP URL detail, so an imported chat hides the turn too; any new reader of exported messages must honour it.

When any answer is "Other…", that submit sends nothing. It hands the same lines to the composer instead
(`composerDraftForAnswers`), with each "Other…" line left open. It goes through `setPendingPrompt(threadId,
draft, { focus: true })`, which merges it into the draft and puts the caret at the end, and the user types the
rest and sends it as their own message. The widget then says "Finish your answer in the message box." An
"Other…" picked mid-sequence waits for the last answer, so the turn still carries every answer.

Graded answers used to stay client-side because sending each one goaded the model into asking the next
question in a loop; with one turn per finished message, and the instructions telling the model to wait for it,
there is nothing to race ahead of.

The "Got it, working on that next." note shows only once `sendMessage` resolves with no `chatInstance.error`.
A send can fail in two ways:

- **It throws before the request** (no model selected, say). The turn never left, so the step shows "Your
  answers couldn't be sent." with a Try again button that rebuilds the turn from the saved answers. A reload
  after this kind of failure does not resend.
- **The request fails.** `Chat.sendMessage` catches that itself and resolves with the chat in error. The user
  turn is already in the thread and the chat shows its own error and retry, so the step (status
  `failed-in-chat`) shows no note and no Try again: a widget retry would post the turn twice. The answers stay
  locked.

The sequence's state and the send live in `useAskSequenceState` (`src/widgets/ask/use-ask-sequence-state.ts`).
One card's answer rules (selection, commit on click or Submit, the double-click latch, the saved answer on a
locked card, "Other…" and Skip) live in `useAskState` (`src/widgets/ask/use-ask-state.ts`); `Ask`
(`display.tsx`) only renders, plus the two focus effects that need its DOM refs.

On each submit, `AskSequence` writes an `AskCacheEntry` into the owning message's cache under its key from
`askStorageKeys`. That is `askStorageKey`, `ask/<prompt>#<hash of mode+options>`, hashed so two asks sharing a
prompt but differing in options do not overwrite each other's answer. A byte-identical ask repeated in the same
message gets `~2`, `~3`, … appended to the key, so each occurrence is answered on its own; the first occurrence
keeps the plain key, so answers saved before that rule still restore. An entry may also carry `other: true`
(its `chosen` holds only real options) or `skipped: true` (empty `selectedIds` and `chosen`); older entries
have neither, and `formatAskResponsesNote` reports both to the model. The same key restores state on reload, so
it must derive only from the parsed widget args and their order, never from anything session-scoped. Writes are
read-modify-write on one cache blob, so every sequence in a message chains them on one per-message queue.

Every ask's state also re-enters later turns as a **volatile system note**, not stable prompt text. On each
send, `askResponsesNoteFor` (`src/widgets/ask/message-asks.ts`) calls `collectConversationAskStates`. It takes
each assistant message's asks from its text (`collectMessageAsks`) and pairs them with the answers in its cache
(`askMessageStateOf`, by `askStorageKeys`). `formatAskResponsesNote` renders the result.

Both engines add it on every send:

- **The legacy pipeline** (`src/ai/fetch.ts`) passes it to `buildVolatileSystemNotes`.
- **The in-browser agent harness** (`src/acp/built-in-adapter.ts`, which Tinfoil models always use) appends it
  to the per-send part of the harness system prompt, after the timestamp. It also gets the voice-mode note there,
  through the same `composeAppHarnessSystemPrompt(config, notes)` path.

Skill instructions are not part of that list: each engine places them itself. The note is authoritative and model-facing English. It has one set per asking
message, in order, and each question shows one of these states:

- its answer, plus whether a graded answer matched
- "skipped"
- "answered in their own words in their reply"
- "not answered yet", so the model knows where a quiz stands mid-way

Legacy `free` answers still appear.

A tag scan guards each message's cache read: only an assistant message whose text includes `<widget:ask` is
read, so conversations without an ask widget pay nothing. Keep that guard shape if you add another
cache-read-on-send widget.

## Privacy & Security Via Proxy

**Rule:** External requests go through the backend proxy by default, and always for non-CORS, sensitive, or
credentialed requests. The proxy hides the user IP, sanitizes payloads, controls the User-Agent, and adds
CORS headers.

**Exception:** Keyless, CORS-enabled, non-sensitive APIs (e.g. Open-Meteo) may be fetched directly via the
external `http` client. Preferred for weather: routing every user through the backend's single IP got
Open-Meteo's free tier rate-limited (429s), while client-direct fetches spread across user IPs and avoid a
dedicated backend endpoint. Canonical pattern: `src/widgets/weather-forecast/fetch-forecast.ts`.

### Architecture

```text
Frontend Widget
    ↓ HttpClient (src/lib/http.ts)
    → Backend route (POST /v1/preview, /v1/proxy, /v1/pro/*)
        ↓
        → External API / Website
```

### Example: Link Preview

**❌ WRONG, direct fetch from frontend** (exposes user IP, creates CORS issues):

```typescript
const fetchFn = async () => {
  const response = await fetch(url)
  return parseMetadata(await response.text())
}
```

**✅ CORRECT, through the backend:**

```typescript
// Frontend: src/integrations/thunderbolt-pro/api.ts (error wrapping elided)
export const fetchLinkPreview = async (params: LinkPreviewParams, httpClient: HttpClient) =>
  httpClient.post('preview', { timeout: requestTimeout, json: { url: params.url } }).json<LinkPreviewData>()
```

The widget takes its client from `useHttpClient()` rather than importing one. `backend/src/api/preview.ts`
validates the target with `validateSafeUrl`, fetches through `createSafeFetch` (DNS-checked, blocking SSRF
against internal addresses), and extracts the metadata. It is a **POST**, not a GET, so target URLs never
appear in access logs.

Never use bare `fetch` or `ky` from a widget (see the `HttpClient` rule in `CLAUDE.md`).

### When Going Direct Is Correct

Two standing exceptions, both deliberate:

- **Browser sub-resource loads.** The preview card renders `<img src={image}>` straight from the upstream URL
  (`src/widgets/link-preview/display.tsx`). Proxying thumbnails buys no privacy the page hasn't given away.
- **Keyless, CORS-enabled, non-sensitive APIs.** The weather widget calls Open-Meteo from the client.

### Other Backend Routes

`/v1/pro` mounts only the Exa content-fetch tool (`backend/src/pro/routes.ts`); it is not a per-widget
namespace. For an arbitrary upstream, the universal proxy at `/v1/proxy` (`backend/src/proxy/routes.ts`)
forwards the request, taking the target URL and upstream headers as `X-Proxy-Passthrough-*`.

## Prompt Engineering for Widgets

A widget's `instructions.ts` teaches the model how and when to emit the tag, reaching it as a seeded skill
loaded on demand. The system prompt (`src/ai/prompt.ts`) carries only cross-widget rules.

### 1. Make Widgets Dead Simple

Every parameter lowers the success rate: the model forgets required ones, formats them wrong, or
hallucinates values instead of using tools.

```xml
<!-- ✅ Minimal -->
<widget:link-preview url="https://example.com" />

<!-- ❌ Too many parameters; the widget can fetch all of this itself -->
<widget:link-preview url="https://example.com" title="Page Title" description="Page description"
  image="https://example.com/image.jpg" author="John Doe" publishDate="2024-01-01" />
```

### 2. Token Economics

Every parameter costs tokens on every usage:

```text
# Verbose (100+ tokens per usage)
<widget:weather-forecast location="Seattle" region="Washington" country="United States"
  days="7" units="fahrenheit" includeHourly="true" />

# Minimal (30 tokens per usage)
<widget:weather-forecast location="Seattle" region="WA" country="US" />
```

Across five weather widgets in one chat that is ~350 tokens saved, a ~70% reduction.

### 3. Widget-First Thinking

The system prompt's `# Tools` section already orders this, so `instructions.ts` need not restate it:

```text
Think about what widget components to show the user, then work backwards to the tools you need.
```

### 4. Automatic Data Fetching

Say when a widget fetches its own data, so the model does not call a tool first:

```markdown
## Weather Forecast

<widget:weather-forecast location="City" region="State" country="Country" />
Shows today + the next 5 days (**_fetches data automatically, no search needed_**)
```

### 5. Clear Examples

```markdown
Example: "What's the weather in Seattle?"
→ <widget:weather-forecast location="Seattle" region="Washington" country="United States" />

NOT: "Let me search for the weather... <tool_call>..."
```

### 6. Emphasize Format Requirements

```markdown
## Link Preview

<widget:link-preview url="https://example.com" />

✅ CORRECT:
• One specific news article: apnews.com/article/abc123
• One specific product: roborock.com/products/s8-pro

❌ WRONG:
• Homepage: apnews.com
• Category page: amazon.com/laptops
```

### 7. Prevent Redundancy

```markdown
### NO DUPLICATE CONTENT

The preview card already shows title, description, and image.
Your output: Brief intro (1-2 sentences) + widget tags only.

❌ WRONG:
"Top stories:

1. **Climate Summit** - Leaders met...
   <widget:link-preview url="..." />"

✅ CORRECT:
"Here are today's top stories:

<widget:link-preview url="..." />
<widget:link-preview url="..." />
<widget:link-preview url="..." />"
```

### Example Instructions File

`src/widgets/weather-forecast/instructions.ts`, in full:

```markdown
## Weather Forecast

<widget:weather-forecast location="City" region="State" country="Country" />
Shows today + the next 5 days (**_fetches data automatically, no search needed_**)
Example: <widget:weather-forecast location="Seattle" region="Washington" country="United States" />

### Forecast Limitations

The forecast covers today and the next 5 days (6 days total).
• If asked for forecasts beyond 6 days: "I can only show the forecast for the next 6 days."
• If asked for a time period that is a few days from now: "I can't forecast that far in advance, but here's the next 6 days." + show component
```

The day count is load-bearing: the widget requests `days: 6` from Open-Meteo, so a prompt promising seven
would have the model offer a day the card never renders.

## Best Practices

### 1. Design for Offline-First

Cache everything display needs. A live call at render time breaks offline.

```typescript
// ✅ fully self-contained
const { data } = useMessageCache({
  messageId,
  cacheKey: ['stockChart', symbol],
  fetchFn: async () => {
    const result = await getStockData({ symbol })
    return { price: result.price, change: result.change, history: result.history, companyName: result.companyName }
  },
})

// ❌ the cached payload is incomplete, so display needs a live call
const { data } = useMessageCache({ ... })
const companyName = await getCompanyName(symbol) // Won't work offline!
```

### 2. Graceful Error Handling

Never crash. Render something useful for both the error and the empty case:

```typescript
if (error) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm text-red-800">Unable to load widget: {error.message}</p>
    </div>
  )
}

if (!data) return <div className="text-muted-foreground">No data available</div>
```

### 3. Consistent Loading States

Skeleton loaders should match the final component's size:

```typescript
if (isLoading) {
  return (
    <div className="space-y-2">
      <Skeleton className="h-8 w-32" /> {/* Title */}
      <Skeleton className="h-64 w-full" /> {/* Chart */}
    </div>
  )
}
```

### 4. Deterministic Cache Keys

```typescript
// ✅ includes all parameters
cacheKey: ['weatherForecast', location, region, country]

// ❌ missing parameter
cacheKey: ['weatherForecast', location]

// ❌ includes timestamp
cacheKey: ['weatherForecast', location, Date.now().toString()]
```

### 5. Validation at Parse Time

Validate during parsing, not rendering. `createParser()` handles the common case:

```typescript
import { createParser } from '@/lib/create-parser'

export const parse = createParser(schema)
```

A hand-written parser returns `null` for anything invalid, and the widget does not render:

```typescript
// schema.ts
export const parse = (attrs: Record<string, string>): MyWidget | null => {
  if (!attrs.symbol?.trim()) return null

  return (
    schema.safeParse({
      widget: 'my-widget',
      args: { symbol: attrs.symbol.trim().toUpperCase() },
    }).data ?? null
  )
}
```

### 6. Streaming Support

The parser drops incomplete tags while streaming:

```typescript
// During streaming: "Check out <widget:link-pr"  → renders "Check out"
// After complete:   "Check out <widget:link-preview url="..." />" → renders the widget
```

A widget with a slow or bulky payload should also export a `Skeleton`. Once a partial tag has typed a
skeleton-capable widget name followed by whitespace (the model has committed and is streaming attributes),
the parser emits a third part kind, `{ type: 'widget-loading', name }`. Without a `Skeleton` a widget renders
nothing until its closing `/>` arrives: fine for a short tag, jarring for `map`, which opens its tag long
before its GeoJSON payload finishes.

Streaming callers (`src/components/chat/text-part.tsx`, `src/voice/session.ts`) use
`parseContentPartsIncremental`, not `parseContentParts`. It keeps a per-part state cache and returns
marker-free growing prose directly instead of re-scanning for tags and citation brackets on every render.
Anything containing a `<` or a `【` falls back to a full parse.

### 7. Semantic HTML & Accessibility

```typescript
<article className="rounded-lg border" aria-label={`Weather forecast for ${location}`}>
  <h3 className="text-lg font-bold">{location}</h3>
  <table>
    <thead>
      <tr>
        <th scope="col">Day</th>
        <th scope="col">Temperature</th>
      </tr>
    </thead>
    <tbody>{/* ... */}</tbody>
  </table>
</article>
```

### 8. Responsive Design

```typescript
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">{/* Responsive grid */}</div>
```

### 9. Performance

- ✅ Use `memo()` for expensive renders
- ✅ Lazy load heavy dependencies
- ✅ Give images explicit dimensions and `loading="lazy"` so a late-loading thumbnail doesn't shift the layout
- ❌ Don't fetch on every render
- ❌ Don't include large libraries unnecessarily

### 10. Type Safety

Use TypeScript strictly, no `any`:

```typescript
type WeatherData = {
  temperature: number
  conditions: string
  forecast: Array<{ day: string; high: number; low: number }>
}

const { data } = useMessageCache<WeatherData>({ ... })
//     ^? WeatherData | undefined
```

## Testing

### Unit Tests for Parser

```typescript
// src/ai/widget-parser.test.ts (excerpt)
describe('widget-parser', () => {
  it('parses single link preview', () => {
    const result = parseContentParts('<widget:link-preview url="https://example.com" />')

    expect(result).toEqual([
      { type: 'widget', widget: { widget: 'link-preview', args: { url: 'https://example.com' } } },
    ])
  })

  it('rejects empty url attribute', () => {
    // A tag that fails schema validation is dropped, not rendered as raw text
    expect(parseContentParts('<widget:link-preview url="" />')).toEqual([])
  })

  it('preserves order of mixed content', () => {
    const result = parseContentParts('Before <widget:link-preview url="https://example.com" /> After')

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ type: 'text', content: 'Before' })
    expect(result[1].type).toBe('widget')
    expect(result[2]).toEqual({ type: 'text', content: 'After' })
  })

  it('handles streaming incomplete tags', () => {
    expect(parseContentParts('Text <widget:link-pr')).toEqual([{ type: 'text', content: 'Text' }])
  })
})
```

One asymmetry: a tag whose **attributes** fail validation is dropped, but a tag with no attributes at all
(`<widget:link-preview />`) never matches the tag regex and survives as literal text.

### Schema Tests

```typescript
// src/widgets/my-widget/schema.test.ts
import { describe, expect, it } from 'bun:test'
import { parse } from './schema'

describe('my-widget schema', () => {
  it('parses valid attributes', () => {
    expect(parse({ attribute: 'value' })).toEqual({ widget: 'my-widget', args: { attribute: 'value' } })
  })

  it('returns null for missing attributes', () => {
    expect(parse({})).toBeNull()
    expect(parse({ attribute: '' })).toBeNull()
  })
})
```

### Integration Tests for Components

Widget tests run under `bun:test`, not Vitest (present only as Storybook browser tooling). A widget using
`useMessageCache` reads the local database, so it needs a test database and the app providers.
`src/widgets/link-preview/widget.test.tsx` is the reference:

```tsx
// src/widgets/link-preview/widget.test.tsx (excerpt)
import '@/testing-library'
import { ExternalLinkDialogProvider } from '@/components/chat/markdown-utils'
import { ContentViewProvider } from '@/content-view/context'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { render } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import type { ReactElement } from 'react'
import { LinkPreviewWidget } from './widget'

const renderWithProviders = (ui: ReactElement) => {
  const TestProvider = createTestProvider()
  return render(ui, {
    wrapper: ({ children }) => (
      <TestProvider>
        <ContentViewProvider>
          <ExternalLinkDialogProvider>{children}</ExternalLinkDialogProvider>
        </ContentViewProvider>
      </TestProvider>
    ),
  })
}

describe('LinkPreviewWidget', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  it('renders instantly when source index matches a source entry', () => {
    // makeSource() builds a SourceMetadata fixture; see the file for its defaults
    const { getByText } = renderWithProviders(
      <LinkPreviewWidget url="https://example.com/article" source="1" sources={[makeSource()]} messageId="msg-1" />,
    )

    expect(getByText('Example Article')).toBeTruthy()
  })
})
```

Three things that are easy to get wrong:

- **`import '@/testing-library'` comes first.** It swaps Lingui's macros for identity implementations; Bun
  runs no Babel pass, so without it any widget rendering `<Trans>` throws.
- **Inject the fetch, don't mock the module.** `LinkPreviewWidget` takes an optional `fetchPreviewFn` prop.
  Reach for `mock()` from `bun:test` only when there is no seam.
- **Run `bun run test`**, never a bare `bun test` at the repo root: the root run discovers backend tests,
  which open real connections and hang (see `CLAUDE.md`).

### Backend API Tests

Test a widget's backend route against the assembled app, not the route factory alone, so the auth macro, the
rate limiter and the SSRF-safe fetch are in the path. In `backend/src/api/preview.e2e.test.ts`,
`createTestApp` builds the app with an injected `fetchFn`, `createUpstreamRouter` stands in for the outside
world, and the test drives `app.handle()` with a real `Request`:

```typescript
// backend/src/api/preview.e2e.test.ts (excerpt)
const upstream = createTestUpstream(
  'preview.test',
  () =>
    new Response(buildHtml('<meta property="og:title" content="Hello &amp; world" />'), {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
)
handle = await createTestApp({ fetchFn: createUpstreamRouter({ 'preview.test': upstream }) })

const res = await handle.app.handle(
  new Request('http://localhost/v1/preview', {
    method: 'POST',
    headers: { ...authHeaders(handle.bearerToken), 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://preview.test/article' }),
  }),
)

expect(res.status).toBe(200)
```

Backend tests run with `bun run test:backend`, a separate run from the frontend `bun run test`.
