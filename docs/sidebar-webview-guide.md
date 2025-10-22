# Sidebar Webview Guide

This guide explains how to show a webview in the right sidebar when clicking preview links.

## Overview

The sidebar webview feature allows you to display web content in a full-size webview that fills the right sidebar panel. The webview automatically tracks the sidebar's size and position, updating smoothly when the panel is resized.

## Quick Example

```tsx
import { SidebarWebview } from '@/components/sidebar-webview'
import { useState } from 'react'

function MyComponent() {
  const [webviewConfig, setWebviewConfig] = useState(null)

  const handlePreviewClick = (url: string) => {
    setWebviewConfig({ url })
  }

  return (
    <div ref={containerRef} className="w-full h-full">
      {webviewConfig ? (
        <SidebarWebview 
          config={webviewConfig} 
          onClose={() => setWebviewConfig(null)} 
        />
      ) : (
        <div>
          <button onClick={() => handlePreviewClick('https://example.com')}>
            Show Preview
          </button>
        </div>
      )}
    </div>
  )
}
```

## Files Created

### Core Implementation
1. **`src/hooks/use-sidebar-webview.ts`** - Hook that manages webview lifecycle
   - Tracks container DOM element
   - Creates webview positioned over container
   - Handles resize with ResizeObserver
   - Automatic cleanup

2. **`src/components/sidebar-webview.tsx`** - React component
   - Provides UI container
   - Close button overlay
   - Loading states
   - Platform detection

3. **`src/layout/sideview-with-webview.tsx`** - Example integration
   - Shows how to integrate with existing sideview
   - Demonstrates preview toggling
   - Export helper hook

### Tests
4. **`src/hooks/use-sidebar-webview.test.ts`** - Unit tests

### Documentation
5. **`docs/sidebar-webview-guide.md`** (this file)

## How It Works

### 1. Container Tracking

The hook uses a `ref` to track the sidebar container element:

```tsx
const containerRef = useRef<HTMLDivElement>(null)
const { isInitialized } = useSidebarWebview(config, containerRef)

return <div ref={containerRef}>...</div>
```

### 2. Position Calculation

When initialized, the hook:
1. Gets the container's `getBoundingClientRect()`
2. Creates a webview at that exact position
3. Sets the webview size to match the container

### 3. Resize Handling

The hook uses `ResizeObserver` to watch for size changes:
- When container resizes, updates webview position/size
- Debounced (50ms) for smooth performance
- Works with ResizablePanel drag handles

### 4. Cleanup

When the component unmounts or config becomes null:
- Disconnects ResizeObserver
- Closes the webview
- Cleans up all listeners

## Integration with Existing Code

### Option 1: Replace Sideview Component

Update `src/layout/main-layout.tsx`:

```tsx
import { SideviewWithWebview } from './sideview-with-webview'

// In your JSX:
<SidebarContent className="w-full h-full overflow-scroll">
  <SideviewWithWebview />
</SidebarContent>
```

### Option 2: Use the Hook Directly

```tsx
import { useSideviewWebview } from '@/layout/sideview-with-webview'

function MyComponent() {
  const { webviewConfig, showPreview, closePreview, isPreviewOpen } = useSideviewWebview()

  const handleLinkClick = () => {
    showPreview('https://example.com')
  }

  return (
    <>
      {!isPreviewOpen && (
        <button onClick={handleLinkClick}>Show Preview</button>
      )}
      {isPreviewOpen && (
        <SidebarWebview config={webviewConfig} onClose={closePreview} />
      )}
    </>
  )
}
```

### Option 3: Custom Integration

```tsx
import { SidebarWebview } from '@/components/sidebar-webview'
import type { SidebarWebviewConfig } from '@/hooks/use-sidebar-webview'
import { useState } from 'react'

function CustomSidebar() {
  const [config, setConfig] = useState<SidebarWebviewConfig | null>(null)

  // Your existing content rendering
  const renderContent = () => {
    // ... your content here
    // When user clicks a preview link:
    // setConfig({ url: 'https://...' })
  }

  return config ? (
    <SidebarWebview config={config} onClose={() => setConfig(null)} />
  ) : (
    renderContent()
  )
}
```

## Features

### Full-Size Webview
- Takes complete width and height of sidebar
- Real webview, not iframe
- Independent rendering and state

### Automatic Resize
- Tracks ResizablePanel changes
- Smooth updates with 50ms debounce
- Works with drag handles

### Close Button
- Floating X button in top-right
- Calls onClose callback
- Closes webview properly

### Platform Detection
- Only works in Tauri desktop app
- Shows helpful message in web/mobile

## Configuration

### SidebarWebviewConfig

```typescript
type SidebarWebviewConfig = {
  url: string           // URL to display
  onClose?: () => void  // Optional callback when webview closes
}
```

### Examples

**Simple URL:**
```tsx
<SidebarWebview 
  config={{ url: 'https://example.com' }} 
  onClose={() => console.log('closed')} 
/>
```

**With callback:**
```tsx
<SidebarWebview 
  config={{
    url: 'https://example.com',
    onClose: () => {
      // Custom cleanup
      analytics.track('preview_closed')
    }
  }} 
  onClose={() => setConfig(null)}
/>
```

## Permissions

Uses the same permissions as dual webview (already configured):
- ✅ `core:webview:allow-create-webview-window`
- ✅ `core:webview:allow-webview-size`
- ✅ `core:webview:allow-webview-position`

## Platform Support

| Platform | Support |
|----------|---------|
| macOS    | ✅ Full |
| Windows  | ✅ Full |
| Linux    | ✅ Full |
| Web      | ❌ No   |
| iOS      | ❌ No   |
| Android  | ❌ No   |

## Troubleshooting

### Webview not showing

1. **Check container ref**: Ensure the ref is attached to a visible element
   ```tsx
   const containerRef = useRef<HTMLDivElement>(null)
   // ...
   <div ref={containerRef} className="w-full h-full">
   ```

2. **Verify config is set**: Config must not be null
   ```tsx
   console.log('Config:', webviewConfig)
   ```

3. **Check Tauri platform**: Only works in desktop app
   ```tsx
   import { isTauri } from '@/lib/platform'
   console.log('Is Tauri:', isTauri())
   ```

### Webview in wrong position

1. **Container dimensions**: Ensure container has explicit dimensions
   ```tsx
   <div ref={containerRef} className="w-full h-full">
   ```

2. **Layout shifts**: Check if container position changes after initial render
   - ResizeObserver will catch this and update

3. **Z-index issues**: Webview should automatically layer correctly

### Resize not working

1. **ResizeObserver support**: Check browser compatibility (should be fine)
2. **Container element**: Must be a real DOM element, not React Portal
3. **Console errors**: Check for webview.setSize() errors

### Performance issues

1. **Debounce timing**: Currently 50ms, increase if needed:
   ```tsx
   // In use-sidebar-webview.ts, line ~76
   }, 50) // Increase this value
   ```

2. **Too many updates**: Check if container is constantly resizing

## Advanced Usage

### Dynamic URL Changes

The webview automatically reinitializes when URL changes:

```tsx
const [url, setUrl] = useState('https://example.com')

// Later:
setUrl('https://different.com') // Webview will reload
```

### Manual Close

```tsx
const { closeWebview } = useSidebarWebview(config, containerRef)

// Close programmatically:
await closeWebview()
```

### Custom Loading State

```tsx
import { useSidebarWebview } from '@/hooks/use-sidebar-webview'

function CustomSidebarWebview({ config }: { config: SidebarWebviewConfig }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { isInitialized } = useSidebarWebview(config, containerRef)

  return (
    <div ref={containerRef} className="relative w-full h-full">
      {!isInitialized && (
        <div className="flex items-center justify-center h-full">
          <YourCustomSpinner />
        </div>
      )}
    </div>
  )
}
```

## Best Practices

1. **Always provide onClose**: Handle cleanup properly
   ```tsx
   const config = {
     url: '...',
     onClose: () => {
       setWebviewConfig(null)
       // Other cleanup
     }
   }
   ```

2. **Use null to disable**: Set config to null to close webview
   ```tsx
   setWebviewConfig(null) // Closes and cleans up
   ```

3. **Check platform first**: Don't try to show webview in browser
   ```tsx
   if (!isTauri()) {
     return <div>Desktop only feature</div>
   }
   ```

4. **Handle errors gracefully**: Webview creation can fail
   ```tsx
   try {
     setWebviewConfig({ url: '...' })
   } catch (error) {
     console.error('Failed to show preview:', error)
   }
   ```

## Testing

Run tests:
```bash
bun test sidebar-webview
```

## Comparison: Sidebar Webview vs Dual Webview

| Feature | Sidebar Webview | Dual Webview |
|---------|----------------|--------------|
| Use case | Preview in sidebar | Split-screen app |
| Webviews | 1 | 2 |
| Complexity | Simple | More complex |
| Splitter | No | Yes, draggable |
| Resize | Auto from container | Manual + auto |
| Integration | Drop-in component | Full layout |

## Example: Email Preview

```tsx
function EmailSideview() {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const handleViewEmail = (emailId: string) => {
    // Open email in webview
    setPreviewUrl(`https://mail.example.com/email/${emailId}`)
  }

  return previewUrl ? (
    <SidebarWebview
      config={{ url: previewUrl }}
      onClose={() => setPreviewUrl(null)}
    />
  ) : (
    <EmailList onEmailClick={handleViewEmail} />
  )
}
```

## Summary

The sidebar webview is perfect for:
- ✅ Preview links in sidebar
- ✅ Full-page content in sidebar panel
- ✅ Automatic resize handling
- ✅ Simple integration

It's **not** for:
- ❌ Multiple simultaneous webviews (use dual webview instead)
- ❌ Custom split layouts (use dual webview instead)
- ❌ Web browser embedding (Tauri desktop only)

