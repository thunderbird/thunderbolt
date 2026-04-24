# Widgets

This guide covers how to develop and use the widget system in Thunderbolt. Widgets are rich, interactive UI components that the AI can embed in its responses using XML-like tags.

## Table of Contents

- [Quick Start: Adding a Widget](#quick-start-adding-a-widget)
- [Architecture Overview](#architecture-overview)
- [How Widgets Work](#how-widgets-work)
- [Message Cache System](#message-cache-system)
- [Privacy & Security via Proxy](#privacy--security-via-proxy)
- [Prompt Engineering for Widgets](#prompt-engineering-for-widgets)
- [Best Practices](#best-practices)
- [Testing](#testing)

## Quick Start: Adding a Widget

Adding a new widget requires **creating one directory** and **updating ONE file**!

### Widget File Structure

Each widget lives in its own directory with a clean, consistent structure:

```
src/widgets/my-widget/
  ├── instructions.ts    # AI prompt instructions
  ├── schema.ts          # Zod schema + auto-generated parser
  ├── widget.tsx         # Main widget component (fetches & displays)
  ├── index.ts           # Public exports
  └── stories.tsx        # Storybook stories (optional)
```

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

#### `src/widgets/my-widget/instructions.ts`

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
export { instructions } from './instructions'
export { parse, schema } from './schema'
export type { CacheData, MyWidget as MyWidgetType } from './schema'
```

**Important:** Export your main component as both its specific name AND as `Component` - this allows the registry to auto-wire it!

#### `src/widgets/my-widget/constants.ts` (Optional)

If your widget needs shared constants (e.g., sessionStorage keys, event names, configuration values), create a constants file:

```typescript
export const myWidgetFlag = 'my_widget_flag'
export const myWidgetEvent = 'my-widget-event'
export const getMyWidgetKey = (messageId: string, key: 'state' | 'data') =>
  `my_widget_${messageId}_${key}`
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

### Step 3: Register in Central Registry (ONE FILE!)

Edit `src/widgets/index.ts`:

```typescript
import * as linkPreview from './link-preview'
import * as myWidget from './my-widget' // Add import
import * as weatherForecast from './weather-forecast'

// Add to exports
export { LinkPreview, LinkPreviewSkeleton, LinkPreviewWidget } from './link-preview'
export { MyWidget } from './my-widget' // Add export
export { WeatherForecastWidget } from './weather-forecast'

// Add to registry - THIS AUTO-WIRES EVERYTHING!
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
```

### Done!

That's it! The widget system automatically wires:

- ✅ AI instructions to the system prompt
- ✅ Zod schema for validation
- ✅ Parser for tag parsing
- ✅ Component for rendering
- ✅ Cache data type for database

No need to touch `widget-types.ts`, `widget-parser.ts`, `widget-renderer.tsx`, or `db/tables.ts`!

### Key Features

- **Simple and readable**: `createParser()` auto-generates parsers from schemas
- **Lowercase naming**: `widgetRegistry`, `parse`, `instructions` (not CAPS)
- **Minimal boilerplate**: Just 4-5 files per widget
- **Clean file names**: `widget.tsx`, `schema.ts`, `stories.tsx` (no redundant prefixes)
- **One place to update**: Add to `widgetRegistry` and you're done!
- **Auto-wired types**: Cache data types automatically update in database schema

### Real-World Examples

**Simple Widget: Link Preview**

```
src/widgets/link-preview/
  ├── instructions.ts    # AI instructions
  ├── schema.ts          # Schema with URL validation
  ├── widget.tsx         # Fetches + displays preview
  ├── index.ts           # Exports
  └── stories.tsx        # Storybook stories
```

**Complex Widget: Weather Forecast**

```
src/widgets/weather-forecast/
  ├── instructions.ts    # AI instructions
  ├── schema.ts          # Schema with location args
  ├── widget.tsx         # Fetches weather data
  ├── display.tsx        # Presentation component
  ├── lib.ts             # Weather utilities & types
  ├── lib.test.ts        # Unit tests
  ├── index.ts           # Exports
  └── stories.tsx        # Storybook stories
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

```
src/widgets/
├── index.ts                    # Central registry and exports
├── weather-forecast/
│   ├── index.ts                # Widget exports
│   ├── instructions.ts         # AI prompt instructions
│   ├── schema.ts               # Zod schema + parse function
│   ├── widget.tsx              # Component implementation
│   ├── display.tsx             # Presentation component
│   ├── lib.ts                  # Utilities and types
│   ├── lib.test.ts             # Unit tests
│   └── stories.tsx             # Storybook stories
└── link-preview/
    ├── index.ts                # Widget exports
    ├── instructions.ts         # AI prompt instructions
    ├── schema.ts               # Zod schema + parse function
    ├── widget.tsx              # Component implementation
    └── stories.tsx             # Storybook stories
```

This organization keeps everything related to a widget in one place, making it easy to maintain and understand.

### File Naming Conventions

- **Directory names**: Use kebab-case (e.g., `weather-forecast`, `link-preview`, `stock-chart`)
- **Component files**: Named `widget.tsx` (consistent across all widgets)
- **Instructions file**: Always named `instructions.ts`
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

// Everything else is auto-generated:
export const widgetPrompts = [
  '# Widget Components',
  'Use these XML-like tags in your response to show rich widgets:',
  '',
  ...widgetRegistry.flatMap((widget) => [widget.module.instructions, '']),
]
  .join('\n')
  .trim()

export const widgetParsers = widgetRegistry.map((widget) => ({
  tagName: widget.name,
  parse: widget.module.parse,
}))

export const widgetSchemas = widgetRegistry.map((widget) => widget.module.schema)

export const widgetComponents = Object.fromEntries(
  widgetRegistry.map((widget) => [widget.name, widget.module.Component]),
)
```

## How Widgets Work

### 1. LLM Response with Widget Tags

The AI includes XML-like tags in its response:

```
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
export const WeatherForecastWidget = ({ location, region, country, messageId }) => {
  const { data, isLoading, error } = useMessageCache({
    messageId,
    cacheKey: ['weatherForecast', location, region, country],
    fetchFn: async () => getWeatherForecast({ location, region, country, days: 7 })
  })

  if (isLoading) return <Skeleton />
  if (error) return <ErrorState />
  return <WeatherForecast {...data} />
}
```

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

## Privacy & Security Via Proxy

**Critical:** All external network requests MUST go through the backend proxy. Never fetch directly from the frontend.

### Why Use the Proxy?

1. **Privacy:** Hides user IP addresses from third-party servers
2. **Security:** Sanitizes requests and responses, prevents CORS issues
3. **User Agent Control:** Presents a consistent identity to external services
4. **CORS Handling:** Adds proper headers for cross-origin requests

### Architecture

```
Frontend Widget
    ↓
    → Backend API endpoint (/pro/link-preview, /pro/weather, etc.)
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

**✅ CORRECT - Through backend proxy:**

```typescript
// Frontend: src/integrations/thunderbolt-pro/api.ts
export const fetchLinkPreview = async (params: LinkPreviewParams) => {
  const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
  const response = await ky.get(`${cloudUrl}/pro/link-preview/${encodeURIComponent(params.url)}`)
  return response.json()
}

// Backend: backend/src/pro/link-preview.ts
export const createLinkPreviewRoutes = () => {
  return new Elysia({ prefix: '/link-preview' }).get('/*', async (ctx) => {
    const targetUrl = decodeURIComponent(/* ... */)

    // Backend makes the actual request
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ThunderboltBot/1.0)',
        // ... other headers
      },
    })

    const html = await response.text()
    return extractMetadata(html, targetUrl)
  })
}
```

### Using the Generic Proxy

For simple GET requests (like images), use the generic proxy:

```typescript
// Frontend
const imageUrl = data.image && cloudUrl
  ? `${cloudUrl}/pro/proxy/${encodeURIComponent(data.image)}`
  : null

// Backend: backend/src/pro/proxy.ts
// Generic proxy at /proxy/* - just pass the URL
<img src={imageUrl} />
```

The proxy automatically:

- Validates URLs
- Adds appropriate CORS headers
- Forwards relevant cache headers
- Handles errors gracefully

## Prompt Engineering for Widgets

The system prompt is critical for teaching the LLM how and when to use widgets.

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

```
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

Train the LLM to think about widgets before tools:

```markdown
# Tools

Call tools ONLY when you need real-time/external data.
• First think about what widget components you need to show the user
• Then think backwards from the widget components to the tools you need to call, if any
```

This encourages the LLM to plan its response structure first.

#### 4. Automatic Data Fetching

Emphasize when widgets fetch their own data:

```markdown
## Weather Forecast

<widget:weather-forecast location="City" region="State" country="Country" />
Shows the next 7 days starting from today (**_fetches data automatically—no search needed_**)
```

This prevents the LLM from making unnecessary tool calls.

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

### Example Prompt Section

Here's how weather forecast is documented in the prompt:

```markdown
## Weather Forecast

<widget:weather-forecast location="City" region="State" country="Country" />
Shows the next 7 days starting from today (**_fetches data automatically—no search needed_**)
Example: <widget:weather-forecast location="Seattle" region="Washington" country="United States" />

### Forecast Limitations

The forecast ONLY covers the next 7 days from today.
• If asked for forecasts beyond 7 days: "I can only show the forecast for the next 7 days."
• If asked for a time period that is a few days from now: "I can't forecast that far in advance, but here's the next 7 days." + show component
```

This prompt section:

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
const data = await useMessageCache({
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
  }
})

// ❌ Bad - relies on external state
const data = await useMessageCache({ ... })
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

The parser automatically handles incomplete widgets during streaming:

```typescript
// During streaming: "Check out <widget:link-pr"
// Parser removes incomplete tag, shows: "Check out"

// After complete: "Check out <widget:link-preview url="..." />"
// Parser shows full widget
```

No special handling needed in your widget component!

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
- ✅ Optimize images (use Next.js Image or similar)
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
// src/ai/widget-parser.test.ts
describe('widget-parser', () => {
  it('parses valid widget', () => {
    const text = '<widget:stock-chart symbol="AAPL" />'
    const result = parseContentParts(text)

    expect(result).toEqual([
      {
        type: 'widget',
        widget: {
          widget: 'stock-chart',
          args: { symbol: 'AAPL' },
        },
      },
    ])
  })

  it('handles invalid attributes', () => {
    const text = '<widget:stock-chart symbol="" />'
    const result = parseContentParts(text)

    expect(result).toEqual([]) // Invalid widgets are omitted
  })

  it('preserves order of mixed content', () => {
    const text = 'Before <widget:stock-chart symbol="AAPL" /> After'
    const result = parseContentParts(text)

    expect(result).toHaveLength(3)
    expect(result[0]).toEqual({ type: 'text', content: 'Before' })
    expect(result[1].type).toBe('widget')
    expect(result[2]).toEqual({ type: 'text', content: 'After' })
  })

  it('handles streaming incomplete tags', () => {
    const text = 'Text <widget:stock-chart symbol="AAP'
    const result = parseContentParts(text)

    expect(result).toEqual([{ type: 'text', content: 'Text' }])
  })
})
```

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

Test widget components with React Testing Library:

```typescript
// src/widgets/stock-chart/widget.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { StockChartWidget } from './widget'
import { getStockData } from '@/integrations/thunderbolt-pro/api'

vi.mock('@/integrations/thunderbolt-pro/api')

describe('StockChartWidget', () => {
  it('shows loading state initially', () => {
    vi.mocked(getStockData).mockReturnValue(new Promise(() => {}))

    render(<StockChartWidget symbol="AAPL" messageId="test-id" />)

    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('displays stock data when loaded', async () => {
    vi.mocked(getStockData).mockResolvedValue({
      price: 150.25,
      change: 2.5,
      changePercent: 1.69,
      history: []
    })

    render(<StockChartWidget symbol="AAPL" messageId="test-id" />)

    await waitFor(() => {
      expect(screen.getByText('AAPL')).toBeInTheDocument()
      expect(screen.getByText('$150.25')).toBeInTheDocument()
      expect(screen.getByText('+2.5 (1.69%)')).toBeInTheDocument()
    })
  })

  it('shows error state on fetch failure', async () => {
    vi.mocked(getStockData).mockRejectedValue(new Error('API error'))

    render(<StockChartWidget symbol="AAPL" messageId="test-id" />)

    await waitFor(() => {
      expect(screen.getByText(/Unable to load stock data/)).toBeInTheDocument()
    })
  })
})
```

### Backend API Tests

Test your backend endpoints:

```typescript
// backend/src/pro/stock-data.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { treaty } from '@elysiajs/eden'
import { createStockDataRoutes } from './stock-data'

describe('Stock Data API', () => {
  it('returns stock data for valid symbol', async () => {
    const app = createStockDataRoutes()
    const api = treaty(app)

    const response = await api['stock-data']['AAPL'].get()

    expect(response.data?.success).toBe(true)
    expect(response.data?.data.price).toBeGreaterThan(0)
  })

  it('handles invalid symbols', async () => {
    const app = createStockDataRoutes()
    const api = treaty(app)

    const response = await api['stock-data']['INVALID!!!'].get()

    expect(response.data?.success).toBe(false)
    expect(response.data?.error).toBeDefined()
  })
})
```

## Summary

Building widgets in Ghostcat requires attention to:

1. **Message Cache** - Always use `useMessageCache` for data fetching to enable offline support
2. **Proxy Architecture** - Route all external requests through backend endpoints
3. **Prompt Engineering** - Keep widgets simple, minimize parameters, optimize for tokens
4. **Error Handling** - Gracefully handle loading, error, and empty states
5. **Type Safety** - Use Zod schemas and TypeScript strictly
6. **Testing** - Cover parsing, rendering, and API integration
7. **Auto-Generated Parsers** - Use `createParser()` to eliminate duplication

By following these patterns, you'll create widgets that are fast, reliable, privacy-preserving, and easy for the LLM to use correctly.
