# Quick Reference: Adding a Widget

Adding a new widget requires **creating one directory** and **updating ONE file**!

## Step 1: Create Widget Directory

```bash
mkdir -p src/widgets/my-widget
```

## Step 2: Create Required Files

### `src/widgets/my-widget/instructions.ts`

```typescript
export const instructions = `## My Widget
<widget:my-widget attribute="value" />
Brief description of what it does
Example: <widget:my-widget attribute="example" />`
```

### `src/widgets/my-widget/schema.ts`

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

### `src/widgets/my-widget/my-widget.tsx`

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

### `src/widgets/my-widget/index.ts`

```typescript
export { MyWidget, MyWidget as Component } from './my-widget'
export { instructions } from './instructions'
export { parse, schema } from './schema'
export type { CacheData, MyWidget as MyWidgetType } from './schema'
```

**Important:** Export your main component as both its specific name AND as `Component` - this allows the registry to auto-wire it!

### `src/widgets/my-widget/schema.test.ts` (Optional but recommended)

```typescript
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

## Step 3: Register in Central Registry (ONE FILE!)

Edit `src/widgets/index.ts`:

```typescript
import * as linkPreview from './link-preview'
import * as myWidget from './my-widget' // Add import
import * as weatherForecast from './weather-forecast'

// Add to exports
export { LinkPreview, LinkPreviewSkeleton, LinkPreviewWidget } from './link-preview'
export { MyWidget } from './my-widget' // Add export
export { WeatherForecastWidget } from './weather-forecast'

// Add to registry
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

## Done!

That's it! The widget system automatically wires:

- ✅ AI instructions to the system prompt
- ✅ Zod schema for validation
- ✅ Parser for tag parsing
- ✅ Component for rendering
- ✅ Cache data type for database

No need to touch `widget-types.ts`, `widget-parser.ts`, `widget-renderer.tsx`, or `db/tables.ts`!

## Key Features

- **Simple and readable**: Straightforward parse function, no fancy Zod tricks
- **Lowercase naming**: `widgetRegistry`, `parse`, `instructions` (not CAPS)
- **Minimal boilerplate**: Just 4 files per widget (instructions, schema, component, index)
- **One place to update**: Add to `widgetRegistry` and you're done!
- **Auto-wired types**: Cache data types automatically update in database schema
