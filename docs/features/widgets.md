# Widgets

This guide covers how to develop and use the widget system in Thunderbolt. Widgets are rich, interactive UI components that the AI can embed in its responses using XML-like tags.

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

A display-only widget — one the app renders from a tag something else already produced — is one directory plus one entry in `src/widgets/index.ts`. A widget the **model** is meant to emit needs two more pieces: an `instructions.ts` describing the tag, and a seeded skill that carries those instructions to the model. See [Making a widget model-facing](#making-a-widget-model-facing).

### Widget File Structure

Each widget lives in its own directory with a clean, consistent structure:

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

For more complex widgets, you can add:

- `constants.ts` - Shared constants (sessionStorage keys, event names, etc.)
- `lib.ts` - Utility functions and types
- `lib.test.ts` - Unit tests for utilities
- `display.tsx` - Separate presentation component
- `schema.test.ts` - Tests for schema parsing

### Step 1: Create Widget Directory

```bash
mkdir -p src/widgets/my-widget
```

### Step 2: Create Required Files

#### `src/widgets/my-widget/instructions.ts` (model-emitted widgets only)

This string is not read by the registry. It reaches the model as a seeded skill — see
[Making a widget model-facing](#making-a-widget-model-facing).

```typescript
export const instructions = `## My Widget
<widget:my-widget attribute="value" />
Brief description of what it does
Example: <widget:my-widget attribute="example" />`
```

#### `src/widgets/my-widget/schema.ts`

```typescript
import { createParser } from '@/lib/create-parser'
import { z } from 'zod'

/**
 * Zod schema for my-widget
 */
export const schema = z.object({
  widget: z.literal('my-widget'),
  args: z.object({
    attribute: z.string().min(1, 'Attribute is required'),
  }),
})

export type MyWidget = z.infer<typeof schema>

/**
 * Type of data cached by this widget
 */
export type CacheData = {
  // Define the shape of data your widget caches
  // Example: { title: string; description: string }
}

/**
 * Parse function - auto-generated from schema
 * No need to repeat widget name or args structure!
 */
export const parse = createParser(schema)
```

**Key points:**

- Use `createParser(schema)` to auto-generate the parser
- No need to repeat widget name or args structure
- Simple and readable - no fancy Zod tricks

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

**Important:** Export your main component as both its specific name AND as `Component` - this allows the registry to auto-wire it!

Optionally export a `Skeleton` too. The registry collects it into `widgetSkeletons`, and the parser renders
it as soon as the opening tag appears — see [Streaming Support](#6-streaming-support). `src/widgets/map/index.ts`
does this with `MapWidgetSkeleton as Skeleton`.

#### `src/widgets/my-widget/constants.ts` (Optional)

If your widget needs shared constants (e.g., sessionStorage keys, event names, configuration values), create a constants file:

```typescript
export const myWidgetFlag = 'my_widget_flag'
export const myWidgetEvent = 'my-widget-event'
export const getMyWidgetKey = (messageId: string, key: 'state' | 'data') => `my_widget_${messageId}_${key}`
```

**When to use constants:**

- ✅ Custom event names shared between components
- ✅ Magic strings or numbers used in multiple places
- ✅ Configuration values that might change

**Best practices:**

- Use camelCase for constant names (not SCREAMING_SNAKE_CASE)
- Use descriptive function names for dynamic keys (e.g., `getMyWidgetKey()`)
- Keep constants widget-specific (co-locate with the widget)
- Export constants that are used outside the widget directory

**Example:** The `connect-integration` widget uses constants for OAuth retry coordination:

```typescript
// src/widgets/connect-integration/constants.ts
export const oauthRetryFlag = 'oauth_trigger_retry'
export const oauthRetryEvent = 'oauth-retry-trigger'
export const getOAuthWidgetKey = (messageId: string, key: 'provider' | 'completed') =>
  `oauth_widget_${messageId}_${key}`
```

These constants are then imported in both the widget component and the chat state handler.

### Step 3: Register in Central Registry

Edit `src/widgets/index.ts`:

```typescript
import * as linkPreview from './link-preview'
import * as myWidget from './my-widget' // Add import
import * as weatherForecast from './weather-forecast'

// Add to exports
export { LinkPreview, LinkPreviewSkeleton, LinkPreviewWidget } from './link-preview'
export { MyWidget } from './my-widget' // Add export
export { WeatherForecastWidget } from './weather-forecast'

// Add to registry - the parser, schema, component and skeleton wire themselves from this
export const widgetRegistry = [
  {
    name: 'weather-forecast' as const,
    module: weatherForecast,
  },
  {
    name: 'link-preview' as const,
    module: linkPreview,
  },
  {
    name: 'my-widget' as const, // Add your widget
    module: myWidget,
  },
] as const

// The cache-data union is hand-maintained — add your widget if it caches anything
export type WidgetCacheData = linkPreview.CacheData | weatherForecast.CacheData | myWidget.CacheData
```

### Done!

Registration wires:

- ✅ Zod schema for validation (`widgetSchemas`)
- ✅ Parser for tag parsing (`widgetParsers`)
- ✅ Component for rendering (`widgetComponents`)
- ✅ Streaming skeleton, if the module exports one (`widgetSkeletons`)

No need to touch `widget-types.ts`, `widget-parser.ts`, `widget-renderer.tsx`, or `db/tables.ts`.

Two things are **not** automatic: the `WidgetCacheData` union above, and the model-facing instructions.

### Making a Widget Model-Facing

The registry does not touch `instructions.ts`, and nothing concatenates widget instructions into the system
prompt. Model-facing widget contracts ship as **seeded default skills**: the prompt carries only each skill's
name and description (`buildSkillListing`, `shared/agent-core/skills.ts`), and the model loads the full
instructions on demand with the `skill` tool, so adding a widget does not lengthen every prompt.

To expose a widget to the model, edit `src/defaults/skills.ts`:

1. Import the widget's `instructions` and declare a `Skill` row whose `instruction` is that string, with a
   `description` written as a "use this skill when …" sentence — it is the only thing the model sees before
   loading the skill.
2. Add the skill's id to `widgetSkillIds`. Widget skills hash only their content fields, so a user disabling
   or unpinning the skill cannot block a later contract update (`hashSkill`, same file).
3. Add the row to `defaultSkills`.
4. Bump `defaultSkillsVersion`. It is the ordering signal reconciliation uses across devices, and
   `src/defaults/skills.test.ts` pins a snapshot that fails on any content change without a matching bump.

`citation` and `document-result` deliberately have no skill: the prompt forbids the model from emitting
`<widget:citation>` (`src/ai/prompt.ts`), and `document-result` is reserved for a future document-search mode
whose own mode prompt will carry the guidance. `src/defaults/skills.test.ts` asserts both stay unseeded.

### Key Features

- **Simple and readable**: `createParser()` auto-generates parsers from schemas
- **Lowercase naming**: `widgetRegistry`, `parse`, `instructions` (not CAPS)
- **Minimal boilerplate**: Just 4-5 files per widget
- **Clean file names**: `widget.tsx`, `schema.ts`, `stories.tsx` (no redundant prefixes)
- **One registry**: parser, schema, component and skeleton all derive from `widgetRegistry`

### Real-World Examples

**Simple Widget: Link Preview**

```text
src/widgets/link-preview/
  ├── instructions.ts    # Model-facing instructions
  ├── schema.ts          # Schema with URL validation
  ├── widget.tsx         # Instant-from-metadata path + fetching fallback
  ├── display.tsx        # Presentation component
  ├── utils.ts           # Hostname helpers
  ├── utils.test.ts      # Unit tests
  ├── widget.test.tsx    # Component tests (see Testing)
  ├── index.ts           # Exports
  └── stories.tsx        # Storybook stories
```

**Complex Widget: Weather Forecast**

```text
src/widgets/weather-forecast/
  ├── instructions.ts        # Model-facing instructions
  ├── schema.ts              # Schema with location args
  ├── widget.tsx             # Reads the unit setting, drives the cache
  ├── fetch-forecast.ts      # Open-Meteo geocoding + forecast
  ├── fetch-forecast.test.ts # Geocoding/disambiguation tests
  ├── display.tsx            # Presentation component
  ├── display.test.tsx       # Presentation tests (snapshots in __snapshots__/)
  ├── lib.ts                 # Weather utilities & types
  ├── lib.test.ts            # Unit tests
  ├── index.ts               # Exports
  ├── stories.tsx            # Storybook stories
  └── display.stories.tsx    # Storybook stories for the display component
```

The weather forecast widget demonstrates the optional files for complex widgets:

- **lib.ts**: Utilities like `convertTemperature()`, `getWeatherMetadata()`, and shared types
- **lib.test.ts**: Unit tests for the utility functions
- **display.tsx**: Reusable presentation component that `widget.tsx` renders after fetching data

---

## Architecture Overview

The widget system consists of four main layers:

1. **Parsing Layer** (`src/ai/widget-parser.ts`) - Extracts widget tags from LLM responses
2. **Type System** (`src/ai/widget-types.ts`) - Defines widget schemas using Zod
3. **Rendering Layer** (`src/components/chat/widget-renderer.tsx`) - Maps widgets to React components
4. **Widget Layer** (`src/widgets/`) - Individual widget implementations, organized by feature

Each widget lives in its own directory under `src/widgets/` with all related files co-located:

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
    ├── widget.tsx              # Component implementation
    ├── display.tsx             # Presentation component
    ├── fetch-forecast.ts       # Open-Meteo geocoding + forecast
    ├── lib.ts                  # Utilities and types
    ├── lib.test.ts             # Unit tests
    └── stories.tsx             # Storybook stories
```

This organization keeps everything related to a widget in one place, making it easy to maintain and understand.

### File Naming Conventions

- **Directory names**: Use kebab-case (e.g., `weather-forecast`, `link-preview`, `stock-chart`)
- **Component files**: Named `widget.tsx` (consistent across all widgets)
- **Instructions file**: When present, always named `instructions.ts` — only model-emitted widgets have one
- **Schema file**: Always named `schema.ts` - contains Zod schema AND auto-generated parser
- **Index file**: Always named `index.ts` - exports component, instructions, and schema
- **Test files**: Match the source file name with `.test.ts` suffix (e.g., `lib.test.ts`)
- **Story files**: Always named `stories.tsx`
- **Variable names**: Use lowercase (e.g., `instructions`, `parse`, `widgetRegistry`)
- **Export names**: Use descriptive PascalCase (e.g., `WeatherForecastWidget`, `LinkPreviewWidget`)

### Central Registry Pattern

The `src/widgets/index.ts` file serves as the central registry. You simply import the widget module and add it to the registry:

```typescript
import * as linkPreview from './link-preview'
import * as weatherForecast from './weather-forecast'

// Re-export components
export { LinkPreview, LinkPreviewSkeleton, LinkPreviewWidget } from './link-preview'
export { WeatherForecastWidget } from './weather-forecast'

// Widget registry - just name and module!
export const widgetRegistry = [
  {
    name: 'weather-forecast' as const,
    module: weatherForecast,
  },
  {
    name: 'link-preview' as const,
    module: linkPreview,
  },
] as const

// The four lookup tables are derived from it:
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

Instructions are **not** derived here — see [Making a widget model-facing](#making-a-widget-model-facing).
`WidgetCacheData`, the union the message-cache column is typed against, is written out by hand at the bottom
of the same file.

## Shipped Widgets

Seven widgets are registered in `src/widgets/index.ts`. Five of them are model-facing — each one's
`instructions.ts` is seeded as a skill in `src/defaults/skills.ts`, so the model only loads the contract when
it needs it.

| Widget                | Tag args                                    | Seeded skill        | Notes                                                |
| --------------------- | ------------------------------------------- | ------------------- | ---------------------------------------------------- |
| `weather-forecast`    | `location`, `region`, `country`             | Weather (pinned)    | Fetches Open-Meteo directly from the client          |
| `link-preview`        | `url`, `source`                             | Link Preview        | Metadata via `POST /v1/preview`                      |
| `map`                 | `data` (GeoJSON), `title`                   | Map                 | The only widget exporting a streaming `Skeleton`     |
| `ask`                 | `mode`, `prompt`, `options`, `explanation`  | Ask                 | Writes the user's answer back into the message cache |
| `connect-integration` | `provider`, `service`, `reason`, `override` | Connect Integration | Caches `isHidden` so it disappears once connected    |
| `citation`            | `sources`                                   | —                   | The prompt forbids the model from emitting the tag   |
| `document-result`     | `name`, `fileId`, `snippet`, `score`        | —                   | Reserved for a future document-search mode           |

**`weather-forecast`** geocodes the place with Open-Meteo, then fetches the daily forecast, both from the
browser (`fetch-forecast.ts`). Geocoding always asks in English because the `region`/`country` the model
supplies are usually English and a localized response would match nothing; the winning place name is
re-resolved in the UI locale afterwards, which is why the locale is part of the cache key.

**`link-preview`** renders instantly from search-result metadata when the tag carries a `source` index, and
only falls back to fetching metadata when it does not.

**`map`** takes a GeoJSON `FeatureCollection` as a JSON string. `schema.ts` refines it through
`parseFeatureCollection`, so a malformed collection fails validation and the tag never renders as an empty
map. Points, lines and polygons (and their `Multi*` variants) are supported, styled per the simplestyle-spec.

**`ask`** has four modes: `single` and `multiple` designate a correct answer and are graded client-side;
`choice` and `choices` have none and are conversational — submitting one dispatches the chosen text as a user
turn (`turnTextForAnswer`). A legacy `free` mode is still parsed so historical messages keep rendering, but is
no longer authored. See [Interactive Widgets](#interactive-widgets).

**`connect-integration`** is shown only when the user asks for email or calendar and the matching Google or
Microsoft tools are unavailable; its instructions list the tool names to check first.

**`citation`** renders a `CitationBadge` from a JSON or base64 `sources` attribute. The model is told to cite
with inline `[N]` markers instead (`src/ai/prompt.ts`), so the widget exists for content that already carries
the tag; it declares `CacheData = never`.

**`document-result`** surfaces one source document inline. It has no instructions file — the future Document
Search mode that emits it will carry the guidance in its own mode prompt.

## How Widgets Work

### 1. LLM Response with Widget Tags

The AI includes XML-like tags in its response:

```text
Here's the weather for Seattle:

<widget:weather-forecast location="Seattle" region="Washington" country="United States" />
```

### 2. Parsing

The `parseContentParts()` function splits the response into text and widget parts:

```typescript
const contentParts = parseContentParts(message.text)
// Returns: [
//   { type: 'text', content: "Here's the weather for Seattle:" },
//   { type: 'widget', widget: { widget: 'weather-forecast', args: {...} } }
// ]
```

### 3. Rendering

The `TextPart` component renders each part:

```typescript
{contentParts.map((part, index) => {
  if (part.type === 'text') {
    return <StreamingMarkdown content={part.content} />
  }
  return <WidgetRenderer widget={part.widget} messageId={messageId} />
})}
```

### 4. Widget Component

Each widget component receives its props and handles data fetching:

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

`fetchWeatherForecast` (`src/widgets/weather-forecast/fetch-forecast.ts`) is the canonical example of a
widget that fetches an external API directly from the frontend — see the proxy exception below.

## Message Cache System

The `useMessageCache` hook is central to how widgets work. It provides three critical benefits:

### 1. Instant Display on Revisit

When you view a previous conversation, widgets appear **instantly** without re-fetching:

```typescript
// First time: fetches from API, stores in DB
// Second time: reads from DB cache, returns immediately
const { data } = useMessageCache({
  messageId: message.id,
  cacheKey: ['linkPreview', url],
  fetchFn: async () => fetchLinkPreview({ url }),
})
```

### 2. Offline Support

Once cached, widgets work completely offline. The data is stored in the SQLite database alongside the message:

```typescript
// Database schema
chatMessagesTable = {
  id: string
  content: string
  cache: {
    'linkPreview/https://example.com': { title, description, image },
    'weatherForecast/Seattle/WA/USA': { temperature, forecast, ... }
  }
}
```

### 3. Deduplication

Multiple calls with the same cache key return the same data:

```typescript
// Even if the LLM adds the same widget twice, we only fetch once
<widget:link-preview url="https://example.com" />
<widget:link-preview url="https://example.com" />
// ↓ Single fetch, both render the same cached data
```

### How to Use useMessageCache

```typescript
type UseMessageCacheOptions<T> = {
  messageId: string // Required: identifies which message owns this cache
  cacheKey: string[] // Required: unique key for this data (e.g., ['linkPreview', url])
  fetchFn: () => Promise<T> // Required: function to fetch data if not cached
  enabled?: boolean // Optional: gate the fetch, defaults to true
}

// Example
const { data, isLoading, error } = useMessageCache<MyDataType>({
  messageId: message.id,
  cacheKey: ['myWidget', param1, param2],
  fetchFn: async () => {
    // Fetch from API, database, or compute
    return await fetchMyData(param1, param2)
  },
})
```

**Important:** The cache key should be deterministic and include all parameters that affect the data. Use camelCase for the first element (namespace):

- ✅ Good: `['linkPreview', url]`, `['weatherForecast', location, region, country]`
- ❌ Bad: `['link-preview', url]`, `['LinkPreview', url]`

`enabled` defers the fetch until a dependency has resolved — the weather widget uses it to wait for the
`temperature_unit` setting, so the first fetch already knows which unit to request rather than firing twice.

## Interactive Widgets

Most widgets are one-way: parse a tag, fetch, display. The `ask` widget is the exception, and its pattern is
worth copying if you build another widget the user answers.

On submit, `AskWidget` writes an `AskCacheEntry` into the owning message's cache under a key from
`askStorageKey` — `ask/<prompt>#<hash of mode+options>`, hashed so two asks sharing a prompt but differing in
options do not overwrite each other's answer. The same key restores the widget's state on reload, which is why
the hash is derived only from the parsed widget args and never from anything session-scoped.

The answers re-enter the conversation as a **volatile system note**, not as stable prompt text: on each send,
`src/ai/fetch.ts` collects the entries with `collectAskEntriesFromCache`, renders them with
`formatAskResponsesNote`, and passes the result to `buildVolatileSystemNotes`. So the model can refer back to
what the user chose without the user re-typing it.

That collection is guarded by a cheap tag scan — `messages.some(… part.text.includes('<widget:ask'))` — before
any database read. Conversations without an ask widget, the overwhelming majority, pay nothing. Keep that
guard shape if you add another cache-read-on-send widget.

## Privacy & Security Via Proxy

**Rule:** External network requests go through the backend proxy by default. The proxy is required for any non-CORS, sensitive, or credentialed request (it hides the user IP, sanitizes payloads, controls the User-Agent, and adds CORS headers).

**Exception:** Keyless, CORS-enabled, non-sensitive APIs (e.g. Open-Meteo) may be fetched directly from the widget via the external `http` client. This is preferred for the weather widget: routing every user through the backend's single IP got Open-Meteo's free tier rate-limited (429s), whereas client-direct fetches spread requests across user IPs and avoid coupling the UI to a dedicated backend endpoint. See `src/widgets/weather-forecast/fetch-forecast.ts` for the canonical pattern.

### Why Use the Proxy?

1. **Privacy:** Hides user IP addresses from third-party servers
2. **Security:** Sanitizes requests and responses, prevents CORS issues
3. **User Agent Control:** Presents a consistent identity to external services
4. **CORS Handling:** Adds proper headers for cross-origin requests

### Architecture

```text
Frontend Widget
    ↓ HttpClient (src/lib/http.ts)
    → Backend route (POST /v1/preview, /v1/proxy, /v1/pro/*)
        ↓
        → External API / Website
```

### Example: Link Preview

**❌ WRONG - Direct fetch from frontend:**

```typescript
// DON'T DO THIS - exposes user IP, creates CORS issues
const fetchFn = async () => {
  const response = await fetch(url)
  return parseMetadata(await response.text())
}
```

**✅ CORRECT - Through the backend:**

```typescript
// Frontend: src/integrations/thunderbolt-pro/api.ts (error wrapping elided)
export const fetchLinkPreview = async (params: LinkPreviewParams, httpClient: HttpClient) =>
  httpClient.post('preview', { timeout: requestTimeout, json: { url: params.url } }).json<LinkPreviewData>()
```

The widget takes its client from `useHttpClient()` rather than importing one. The backend side is `backend/src/api/preview.ts`: it validates the target with `validateSafeUrl`,
fetches it through `createSafeFetch` (DNS-checked, to block SSRF against internal addresses), and extracts the
metadata. It is a **POST** rather than a GET so the target URLs never appear in access logs.

Never use bare `fetch` or `ky` from a widget — see the `HttpClient` rule in `CLAUDE.md`.

### When Going Direct Is Correct

The proxy rule has two standing exceptions, both deliberate:

- **Browser sub-resource loads.** The preview card renders `<img src={image}>` straight from the upstream URL
  (`src/widgets/link-preview/display.tsx`). Proxying image loads would mean streaming every thumbnail through
  the backend for no privacy gain the page hasn't already given away.
- **Keyless, CORS-enabled, non-sensitive APIs.** The weather widget calls Open-Meteo from the client, as
  described above.

### Other Backend Routes

`/v1/pro` currently mounts only the Exa content-fetch tool (`backend/src/pro/routes.ts`) — it is not a
per-widget endpoint namespace. When a widget needs to reach an arbitrary upstream, the universal proxy at
`/v1/proxy` (`backend/src/proxy/routes.ts`) forwards the request, taking the target URL and any upstream
headers as `X-Proxy-Passthrough-*` headers.

## Prompt Engineering for Widgets

A widget's `instructions.ts` is what teaches the model how and when to emit the tag. It reaches the model as a
seeded skill loaded on demand, so the guidance below is about writing that file — the system prompt itself
(`src/ai/prompt.ts`) carries only cross-widget rules.

### Key Principles

#### 1. Make Widgets Dead Simple

**Every parameter adds complexity and reduces success rate.** The more parameters a widget requires, the more likely the LLM will:

- Forget a required parameter
- Pass parameters in the wrong format
- Hallucinate values instead of using tools

**✅ Good - Minimal parameters:**

```xml
<widget:link-preview url="https://example.com" />
```

**❌ Bad - Too many parameters:**

```xml
<widget:link-preview
  url="https://example.com"
  title="Page Title"
  description="Page description"
  image="https://example.com/image.jpg"
  author="John Doe"
  publishDate="2024-01-01" />
```

Why? The widget can fetch all metadata automatically! Don't burden the LLM.

#### 2. Token Economics

Every parameter in the prompt costs tokens:

```text
# Verbose approach (100+ tokens per usage)
<widget:weather-forecast
  location="Seattle"
  region="Washington"
  country="United States"
  days="7"
  units="fahrenheit"
  includeHourly="true" />

# Minimal approach (30 tokens per usage)
<widget:weather-forecast location="Seattle" region="WA" country="US" />
```

For a chat with 5 weather widgets, that's **350 tokens saved** (~70% reduction). This means:

- Faster responses
- Lower costs
- More context budget for actual conversation

#### 3. Widget-First Thinking

The `# Tools` section of the system prompt (`src/ai/prompt.ts`) already tells the model to plan its response
structure before its tool calls:

```text
Think about what widget components to show the user, then work backwards to the tools you need.
```

An `instructions.ts` file inherits that ordering and does not need to restate it.

#### 4. Automatic Data Fetching

Emphasize when widgets fetch their own data, so the model does not call a tool first
(`src/widgets/weather-forecast/instructions.ts`):

```markdown
## Weather Forecast

<widget:weather-forecast location="City" region="State" country="Country" />
Shows today + the next 5 days (**_fetches data automatically—no search needed_**)
```

#### 5. Clear Examples

Provide concrete, realistic examples:

```markdown
Example: "What's the weather in Seattle?"
→ <widget:weather-forecast location="Seattle" region="Washington" country="United States" />

NOT: "Let me search for the weather... <tool_call>..."
```

#### 6. Emphasize Format Requirements

Be explicit about attribute format:

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

#### 7. Prevent Redundancy

Teach the LLM not to duplicate content:

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

`src/widgets/weather-forecast/instructions.ts` is the shortest complete example — the whole contract for the
widget, in full:

```markdown
## Weather Forecast

<widget:weather-forecast location="City" region="State" country="Country" />
Shows today + the next 5 days (**_fetches data automatically—no search needed_**)
Example: <widget:weather-forecast location="Seattle" region="Washington" country="United States" />

### Forecast Limitations

The forecast covers today and the next 5 days (6 days total).
• If asked for forecasts beyond 6 days: "I can only show the forecast for the next 6 days."
• If asked for a time period that is a few days from now: "I can't forecast that far in advance, but here's the next 6 days." + show component
```

The day count is not decorative: the widget requests `days: 6` from Open-Meteo, so a prompt promising seven
would have the model offer a day the card never renders.

This section:

- ✅ Shows exact format with clear placeholder names
- ✅ States data is fetched automatically (no tool needed)
- ✅ Provides concrete example
- ✅ Sets clear expectations about limitations
- ✅ Handles edge cases

## Best Practices

### 1. Design for Offline-First

Assume widgets will be viewed offline. Cache everything needed for display:

```typescript
// ✅ Good - fully self-contained
const { data } = useMessageCache({
  messageId,
  cacheKey: ['stockChart', symbol],
  fetchFn: async () => {
    const result = await getStockData({ symbol })
    return {
      price: result.price,
      change: result.change,
      history: result.history,
      companyName: result.companyName,
      // Include ALL data needed for display
    }
  },
})

// ❌ Bad - the cached payload is incomplete, so display needs a live call
const { data } = useMessageCache({ ... })
const companyName = await getCompanyName(symbol) // Won't work offline!
```

### 2. Graceful Error Handling

Widgets should never crash. Always show something useful:

```typescript
if (error) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4">
      <p className="text-sm text-red-800">
        Unable to load widget: {error.message}
      </p>
    </div>
  )
}

if (!data) {
  return (
    <div className="text-muted-foreground">
      No data available
    </div>
  )
}
```

### 3. Consistent Loading States

Use skeleton loaders that match the final component's size:

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

Cache keys must be deterministic and include all parameters:

```typescript
// ✅ Good - includes all parameters
cacheKey: ['weatherForecast', location, region, country]

// ❌ Bad - missing parameter
cacheKey: ['weatherForecast', location]

// ❌ Bad - includes timestamp
cacheKey: ['weatherForecast', location, Date.now().toString()]
```

### 5. Validation at Parse Time

Validate widget parameters during parsing, not rendering:

```typescript
// schema.ts
export const parse = (attrs: Record<string, string>): MyWidget | null => {
  // Validate here
  if (!attrs.symbol?.trim()) {
    return null // Widget won't render
  }

  return (
    schema.safeParse({
      widget: 'my-widget',
      args: { symbol: attrs.symbol.trim().toUpperCase() },
    }).data ?? null
  )
}
```

Or even better, use `createParser()` which handles this automatically:

```typescript
import { createParser } from '@/lib/create-parser'

export const parse = createParser(schema)
```

### 6. Streaming Support

The parser handles incomplete widgets during streaming:

```typescript
// During streaming: "Check out <widget:link-pr"
// Parser removes incomplete tag, shows: "Check out"

// After complete: "Check out <widget:link-preview url="..." />"
// Parser shows full widget
```

A widget with a slow or bulky payload should also export a `Skeleton`. The registry collects those into
`widgetSkeletons`, and once a partial tag has fully typed a skeleton-capable widget name followed by
whitespace — meaning the model has committed to that widget and is now streaming its attributes — the parser
emits a third part kind, `{ type: 'widget-loading', name }`, so the skeleton shows instead of nothing. Widgets
without a `Skeleton` render nothing until their closing `/>` arrives, which is fine for a short tag and
jarring for a long one — `map`, the only widget with a skeleton today, opens its tag well before its GeoJSON
payload has finished generating.

Streaming callers (`src/components/chat/text-part.tsx`, `src/voice/session.ts`) parse through
`parseContentPartsIncremental` rather than `parseContentParts`: it keeps a per-part state cache and, for the
common case of marker-free prose growing token by token, returns the result directly instead of re-scanning
the whole string for tags and citation brackets on every render. Anything containing a `<` or a `【` falls
back to a full parse.

### 7. Semantic HTML & Accessibility

Use proper semantic markup and ARIA labels:

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
    <tbody>
      {/* ... */}
    </tbody>
  </table>
</article>
```

### 8. Responsive Design

Ensure widgets work on mobile and desktop:

```typescript
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {/* Responsive grid */}
</div>
```

### 9. Performance

Keep widget components lightweight:

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
  forecast: Array<{
    day: string
    high: number
    low: number
  }>
}

const { data } = useMessageCache<WeatherData>({ ... })
//     ^? WeatherData | undefined
```

## Testing

### Unit Tests for Parser

Test the parsing logic thoroughly:

```typescript
// src/ai/widget-parser.test.ts (excerpt)
describe('widget-parser', () => {
  it('parses single link preview', () => {
    const result = parseContentParts('<widget:link-preview url="https://example.com" />')

    expect(result).toEqual([
      {
        type: 'widget',
        widget: {
          widget: 'link-preview',
          args: { url: 'https://example.com' },
        },
      },
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
    const result = parseContentParts('Text <widget:link-pr')

    expect(result).toEqual([{ type: 'text', content: 'Text' }])
  })
})
```

One asymmetry worth knowing: a tag whose **attributes** fail validation is dropped, but a tag with no
attributes at all (`<widget:link-preview />`) never matches the tag regex and survives as literal text.

### Schema Tests

Test your schema parsing:

```typescript
// src/widgets/my-widget/schema.test.ts
import { describe, expect, it } from 'bun:test'
import { parse } from './schema'

describe('my-widget schema', () => {
  it('parses valid attributes', () => {
    const result = parse({ attribute: 'value' })

    expect(result).toEqual({
      widget: 'my-widget',
      args: { attribute: 'value' },
    })
  })

  it('returns null for missing attributes', () => {
    expect(parse({})).toBeNull()
    expect(parse({ attribute: '' })).toBeNull()
  })
})
```

### Integration Tests for Components

Widget tests run under `bun:test`, not Vitest (Vitest is present only as Storybook browser tooling). A widget
that uses `useMessageCache` reads the local database, so it needs a test database and the app providers —
`src/widgets/link-preview/widget.test.tsx` is the working reference:

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

- **`import '@/testing-library'` comes first.** It swaps Lingui's macros for identity implementations — Bun
  runs no Babel pass, so without it any widget rendering `<Trans>` throws.
- **Inject the fetch, don't mock the module.** `LinkPreviewWidget` takes an optional `fetchPreviewFn` prop for
  exactly this. Reach for `mock()` from `bun:test` only when there is no seam.
- **Run `bun run test`**, never a bare `bun test` at the repo root — the root run discovers the backend tests,
  which open real connections and hang (see `CLAUDE.md`).

### Backend API Tests

If a widget needs a backend route, test it end to end against the assembled app rather than the route factory
alone — that is the only way the auth macro, the rate limiter and the SSRF-safe fetch are in the path.
`backend/src/api/preview.e2e.test.ts` is the reference: `createTestApp` builds the app with an injected
`fetchFn`, `createUpstreamRouter` stands in for the outside world, and the test drives `app.handle()` with a
real `Request`:

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

Backend tests run with `bun run test:backend`, which is a separate run from the frontend `bun run test`.

## Summary

Building widgets in Thunderbolt requires attention to:

1. **Message Cache** - Always use `useMessageCache` for data fetching to enable offline support
2. **Proxy Architecture** - Route external requests through the backend, with the two documented exceptions
3. **Prompt Engineering** - Keep widgets simple, minimize parameters, optimize for tokens
4. **Error Handling** - Gracefully handle loading, error, and empty states
5. **Type Safety** - Use Zod schemas and TypeScript strictly
6. **Testing** - Cover parsing, rendering, and API integration
7. **Auto-Generated Parsers** - Use `createParser()` to eliminate duplication

By following these patterns, you'll create widgets that are fast, reliable, privacy-preserving, and easy for the LLM to use correctly.
