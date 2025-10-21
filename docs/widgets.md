# Widget Development Guide

This guide covers how to develop and use the widget system in Thunderbolt. Widgets are rich, interactive UI components that the AI can embed in its responses using XML-like tags.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [How Widgets Work](#how-widgets-work)
- [Message Cache System](#message-cache-system)
- [Privacy & Security via Proxy](#privacy--security-via-proxy)
- [Adding a New Widget](#adding-a-new-widget)
- [Prompt Engineering for Widgets](#prompt-engineering-for-widgets)
- [Best Practices](#best-practices)
- [Testing](#testing)

## Architecture Overview

The widget system consists of four main layers:

1. **Parsing Layer** (`src/ai/widget-parser.ts`) - Extracts widget tags from LLM responses
2. **Type System** (`src/ai/widget-types.ts`) - Defines widget schemas using Zod
3. **Rendering Layer** (`src/components/chat/widget-renderer.tsx`) - Maps widgets to React components
4. **Widget Layer** (`src/widgets/`) - Individual widget implementations, organized by feature

Each widget lives in its own directory under `src/widgets/` with all related files co-located:

```
src/widgets/
├── index.ts                              # Central registry and exports
├── weather-forecast/
│   ├── index.ts                          # Widget exports
│   ├── instructions.ts                   # AI prompt instructions
│   ├── schema.ts                         # Zod schema + parse function
│   ├── weather-forecast.tsx              # Component implementation
│   ├── weather-forecast.stories.tsx      # Storybook stories
│   └── weather-forecast.test.ts          # Tests (when needed)
└── link-preview/
    ├── index.ts                          # Widget exports
    ├── instructions.ts                   # AI prompt instructions
    ├── schema.ts                         # Zod schema + parse function
    ├── link-preview.tsx                  # Component implementation
    ├── link-preview.stories.tsx          # Storybook stories
    └── link-preview.test.ts              # Tests (when needed)
```

This organization keeps everything related to a widget in one place, making it easy to maintain and understand.

### File Naming Conventions

- **Directory names**: Use kebab-case (e.g., `weather-forecast`, `link-preview`, `stock-chart`)
- **Component files**: Match the directory name (e.g., `weather-forecast.tsx`)
- **Instructions file**: Always named `instructions.ts`
- **Schema file**: Always named `schema.ts` - contains Zod schema AND `parse` function
- **Index file**: Always named `index.ts` - exports component, instructions, and schema
- **Test files**: Match the component name with `.test.ts` suffix
- **Story files**: Match the component name with `.stories.tsx` suffix
- **Variable names**: Use lowercase (e.g., `instructions`, `parse`, `widgetRegistry`)
- **Export names**: Use descriptive PascalCase (e.g., `WeatherForecastWidget`, not `WeatherForecast`)

### Central Registry Pattern

The `src/widgets/index.ts` file serves as the central registry:

```typescript
// Import instructions from each widget
import { instructions as linkPreviewInstructions } from './link-preview'
import { instructions as weatherForecastInstructions } from './weather-forecast'

// Re-export all widget components
export { LinkPreviewWidget } from './link-preview'
export { WeatherForecastWidget } from './weather-forecast'

// Aggregate instructions for the AI system prompt using array.join()
export const widgetPrompts = [
  '# Widget Components',
  'Use these XML-like tags in your response to show rich widgets:',
  '',
  weatherForecastInstructions,
  '',
  linkPreviewInstructions,
].join('\n')
```

**Why array.join() instead of template literals?**

- Cleaner and easier to edit
- Clear visual separation between sections
- Easy to add/remove widgets
- No nested backticks to manage

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

## Privacy & Security via Proxy

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
  const cloudUrl = await getCloudUrl()
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

## Adding a New Widget

Let's add a stock chart widget as an example. **The entire process requires updating only ONE file** after creating your widget directory!

### Step 1: Create Widget Directory

Create a new directory for your widget:

```bash
mkdir -p src/widgets/stock-chart
```

### Step 2: Define AI Instructions

Create `src/widgets/stock-chart/instructions.ts`:

```typescript
/**
 * AI Instructions for the stock-chart widget
 */
export const instructions = `## Stock Chart
<widget:stock-chart symbol="TICKER" />
Shows current price and historical chart for a stock
Example: <widget:stock-chart symbol="AAPL" />
Note: Use standard ticker symbols (AAPL, GOOGL, TSLA, etc.)`
```

**Key principles for instructions:**

- Use lowercase variable name `instructions` (not `INSTRUCTIONS`)
- Keep instructions concise and clear
- Provide concrete examples
- Specify exact tag format

### Step 3: Define the Schema (with Parser)

Create `src/widgets/stock-chart/schema.ts`:

```typescript
import { z } from 'zod'

/**
 * Zod schema for stock-chart widget
 */
export const schema = z.object({
  widget: z.literal('stock-chart'),
  args: z.object({
    symbol: z.string().min(1, 'Symbol is required'),
  }),
})

export type StockChartWidget = z.infer<typeof schema>

/**
 * Type of data cached by this widget
 */
export type CacheData = StockData

/**
 * Parse function - transforms attributes into widget structure and validates
 */
export const parse = (attrs: Record<string, string>): StockChartWidget | null => {
  if (!attrs.symbol?.trim()) {
    return null
  }

  const result = schema.safeParse({
    widget: 'stock-chart',
    args: {
      symbol: attrs.symbol.toUpperCase(), // Transform here if needed
    },
  })

  return result.success ? result.data : null
}
```

**Key points:**

- Simple and readable - no fancy Zod tricks
- Early validation for quick failure
- Zod validates the transformed structure
- Any transformations happen when building the args object
- This eliminates the need for a separate `parser.ts` file

### Step 4: Create Widget Component

```typescript
// src/widgets/stock-chart/stock-chart.tsx
import { useMessageCache } from '@/hooks/use-message-cache'
import { getStockData } from '@/integrations/thunderbolt-pro/api'

type StockChartWidgetProps = {
  symbol: string
  messageId: string
}

type StockData = {
  price: number
  change: number
  changePercent: number
  history: Array<{ date: string; price: number }>
}

export const StockChartWidget = ({ symbol, messageId }: StockChartWidgetProps) => {
  const { data, isLoading, error } = useMessageCache<StockData>({
    messageId,
    cacheKey: ['stockChart', symbol],
    fetchFn: async () => getStockData({ symbol })
  })

  if (isLoading) return <Skeleton className="h-64 w-full" />

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-800">
          Unable to load stock data: {error.message}
        </p>
      </div>
    )
  }

  if (!data) return null

  return (
    <div className="rounded-lg border p-4">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-lg font-bold">{symbol}</h3>
        <div className="text-right">
          <p className="text-2xl font-bold">${data.price}</p>
          <p className={data.change >= 0 ? 'text-green-600' : 'text-red-600'}>
            {data.change >= 0 ? '+' : ''}{data.change} ({data.changePercent}%)
          </p>
        </div>
      </div>
      <StockChart data={data.history} />
    </div>
  )
}
```

### Step 5: Create Widget Index

Create `src/widgets/stock-chart/index.ts`:

```typescript
export { StockChartWidget } from './stock-chart'
export { instructions } from './instructions'
export { parse, schema } from './schema'
export type { CacheData, StockChartWidget as StockChartWidgetType } from './schema'
```

### Step 6: ✨ Register in Central Registry (THE ONLY UPDATE NEEDED!)

Update `src/widgets/index.ts` - **This is the ONLY file you need to modify outside your widget folder!**

```typescript
import * as linkPreview from './link-preview'
import * as stockChart from './stock-chart' // Add this import
import * as weatherForecast from './weather-forecast'

// Add your component to exports if needed
export { LinkPreview, LinkPreviewSkeleton, LinkPreviewWidget } from './link-preview'
export { StockChartWidget } from './stock-chart' // Add this
export { WeatherForecastWidget } from './weather-forecast'

// Add your widget to the registry - THIS AUTO-WIRES EVERYTHING!
export const widgetRegistry = [
  {
    name: 'weather-forecast' as const,
    instructions: weatherForecast.instructions,
    schema: weatherForecast.schema,
    parse: weatherForecast.parse,
    component: weatherForecast.WeatherForecastWidget,
  },
  {
    name: 'link-preview' as const,
    instructions: linkPreview.instructions,
    schema: linkPreview.schema,
    parse: linkPreview.parse,
    component: linkPreview.LinkPreviewWidget,
  },
  {
    name: 'stock-chart' as const, // Add your widget here
    instructions: stockChart.instructions,
    schema: stockChart.schema,
    parse: stockChart.parse,
    component: stockChart.StockChartWidget,
  },
] as const
```

**That's it!** The registry automatically wires:

- ✅ AI prompt instructions (via `widgetPrompts`)
- ✅ Zod schema for type validation (via `widgetSchemas`)
- ✅ Parser for tag parsing (via `widgetParsers`)
- ✅ Component for rendering (via `widgetComponents`)

No need to update `widget-types.ts`, `widget-parser.ts`, or `widget-renderer.tsx` manually!

### Step 7: Add to Renderer (SKIP - Auto-wired!)

~~You used to need to update widget-renderer.tsx, but this is now automatic!~~

**The widget renderer automatically uses `widgetRegistry` to find and render your component.**

### Step 8: Add Backend API (If Needed)

```typescript
// src/components/chat/widget-renderer.tsx
export const WidgetRenderer = memo(({ widget, messageId }: WidgetRendererProps) => {
  switch (widget.widget) {
    case 'weather-forecast':
      return <WeatherForecastWidget {...widget.args} messageId={messageId} />
    case 'link-preview':
      return <LinkPreviewWidget {...widget.args} messageId={messageId} />
    case 'stock-chart':
      return <StockChartWidget {...widget.args} messageId={messageId} />
    default:
      return null
  }
})
```

### Step 9: Create Backend API (If Needed)

```typescript
// backend/src/pro/stock-data.ts
import { Elysia } from 'elysia'
import { getCorsOrigins, getSettings } from '@/config/settings'
import cors from '@elysiajs/cors'

export const createStockDataRoutes = () => {
  const settings = getSettings()

  return new Elysia({ prefix: '/stock-data' })
    .use(
      cors({
        origin: getCorsOrigins(settings),
        allowedHeaders: settings.corsAllowHeaders,
        exposeHeaders: settings.corsExposeHeaders,
      }),
    )
    .get('/:symbol', async (ctx) => {
      const symbol = ctx.params.symbol.toUpperCase()

      // Fetch from external API (e.g., Alpha Vantage, Yahoo Finance)
      const response = await fetch(`https://api.example.com/stock/${symbol}`, {
        headers: {
          Authorization: `Bearer ${settings.stockApiKey}`,
          'User-Agent': 'Ghostcat/1.0',
        },
      })

      const data = await response.json()

      return {
        success: true,
        data: {
          price: data.price,
          change: data.change,
          changePercent: data.changePercent,
          history: data.history,
        },
      }
    })
}
```

### Step 10: Add Frontend API Client (If Needed)

```typescript
// src/integrations/thunderbolt-pro/api.ts
export const getStockData = async (params: { symbol: string }) => {
  const cloudUrl = await getCloudUrl()
  const response = await ky
    .get(`${cloudUrl}/pro/stock-data/${params.symbol}`, {
      timeout: requestTimeout,
    })
    .json<{ data: StockData; success: boolean; error?: string }>()

  if (!response.success || !response.data) {
    throw new Error(response.error || 'Stock data fetch failed')
  }

  return response.data
}
```

### Step 11: Add Storybook Stories (Optional)

Create `src/widgets/stock-chart/stock-chart.stories.tsx`:

```typescript
import { StockChartWidget } from './stock-chart'
import type { Meta, StoryObj } from '@storybook/react-vite'

const meta = {
  title: 'widgets/stock-chart',
  component: StockChartWidget,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof StockChartWidget>

export default meta
type Story = StoryObj<typeof meta>

export const AAPL: Story = {
  args: {
    symbol: 'AAPL',
    messageId: 'story-message-id',
  },
}
```

### Step 12: Add Tests

```typescript
// src/ai/widget-parser.test.ts
describe('stock chart widgets', () => {
  it('parses single stock chart', () => {
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

  it('uppercases ticker symbols', () => {
    const text = '<widget:stock-chart symbol="aapl" />'
    const result = parseContentParts(text)

    expect(result[0]).toMatchObject({
      type: 'widget',
      widget: {
        args: { symbol: 'AAPL' },
      },
    })
  })

  it('ignores empty symbols', () => {
    const text = '<widget:stock-chart symbol="" />'
    const result = parseContentParts(text)

    expect(result).toEqual([])
  })
})
```

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
// widget-parser.ts
{
  tagName: 'stock-chart',
  parse: (attrs) => {
    const symbol = attrs.symbol?.trim().toUpperCase()

    // Validate here
    if (!symbol || !/^[A-Z]{1,5}$/.test(symbol)) {
      return null // Widget won't render
    }

    return {
      widget: 'stock-chart',
      args: { symbol }
    }
  }
}
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

### Integration Tests for Components

Test widget components with React Testing Library:

```typescript
// src/widgets/stock-chart/stock-chart.test.tsx
import { render, screen, waitFor } from '@testing-library/react'
import { StockChartWidget } from './stock-chart'
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

    const response = (await api.stock) - data['AAPL'].get()

    expect(response.data?.success).toBe(true)
    expect(response.data?.data.price).toBeGreaterThan(0)
  })

  it('handles invalid symbols', async () => {
    const app = createStockDataRoutes()
    const api = treaty(app)

    const response = (await api.stock) - data['INVALID!!!'].get()

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

By following these patterns, you'll create widgets that are fast, reliable, privacy-preserving, and easy for the LLM to use correctly.
