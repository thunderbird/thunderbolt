# Dual Webview Guide

This guide explains how to use the dual webview feature in Thunderbolt, which allows you to display two webviews side-by-side in a single Tauri window.

## Overview

The dual webview implementation uses Tauri v2's multi-webview support to create two real webviews positioned side-by-side. Each webview can display different content and can be resized using a draggable splitter.

## Components

### `useDualWebview` Hook

Located at: `src/hooks/use-dual-webview.ts`

This hook manages the creation and lifecycle of two webviews.

**Features:**
- Automatic webview creation and positioning
- Window resize handling with debouncing
- Dynamic split ratio updates
- Cleanup on unmount

**Usage:**
```typescript
import { useDualWebview } from '@/hooks/use-dual-webview'

const { isInitialized, splitRatio, updateSplitRatio } = useDualWebview({
  leftUrl: 'http://localhost:1420',
  rightUrl: 'http://localhost:1420/settings',
  splitRatio: 0.5, // Optional, defaults to 0.5 (50/50 split)
})
```

### `DualWebviewContainer` Component

Located at: `src/components/dual-webview-container.tsx`

This component provides a UI container with an optional draggable splitter.

**Features:**
- Visual splitter indicator
- Draggable resize with mouse
- Split ratio constraints (10% - 90%)
- Loading state display

**Usage:**
```typescript
import { DualWebviewContainer } from '@/components/dual-webview-container'

<DualWebviewContainer
  config={{
    leftUrl: 'http://localhost:1420',
    rightUrl: 'https://example.com',
    splitRatio: 0.6, // 60/40 split
  }}
  showSplitter={true}
/>
```

## Example Implementation

See `src/pages/dual-webview-example.tsx` for a complete working example.

## Configuration

### Split Ratio

The split ratio determines how much space each webview takes:
- `0.5` = 50/50 split (default)
- `0.3` = 30/70 split (left takes 30%, right takes 70%)
- `0.7` = 70/30 split (left takes 70%, right takes 30%)

The ratio is constrained between `0.1` (10%) and `0.9` (90%) to ensure both views remain usable.

### URLs

Both webviews can display:
- Local app routes (e.g., `http://localhost:1420/settings`)
- External URLs (e.g., `https://example.com`)
- App routes with query parameters (e.g., `http://localhost:1420?sideview=thread:123`)

## Permissions

The necessary permissions are already configured in `src-tauri/capabilities/default.json`:

```json
{
  "permissions": [
    "core:webview:allow-create-webview-window",
    "core:window:allow-create"
  ]
}
```

## Platform Support

The dual webview feature is only available in the Tauri desktop app (macOS, Windows, Linux). It will not work in:
- Web browsers
- Mobile platforms (iOS/Android)

Always check `isTauri()` before initializing dual webviews.

## Architecture

### How It Works

1. **Initialization**: When the component mounts, it:
   - Gets the current window reference
   - Calculates initial dimensions based on window size and split ratio
   - Creates two `Webview` instances with specific positions and sizes

2. **Resize Handling**: When the window is resized:
   - A debounced resize handler (100ms) updates both webviews
   - Maintains the current split ratio while adjusting absolute dimensions

3. **Split Adjustment**: When the user drags the splitter:
   - Mouse movement is tracked
   - Split ratio is recalculated based on cursor position
   - Both webviews are repositioned and resized in real-time

### Webview Lifecycle

- Webviews are created when the component mounts
- They are automatically destroyed when the window closes
- Resize listeners are cleaned up on component unmount

## Customization

### Custom Split Ratios

```typescript
const { updateSplitRatio } = useDualWebview(config)

// Change to 70/30 split
updateSplitRatio(0.7)
```

### Without Splitter

```typescript
<DualWebviewContainer
  config={config}
  showSplitter={false}  // Fixed split, no dragging
/>
```

### Styling

The splitter appearance can be customized using Tailwind classes in `dual-webview-container.tsx`:

```typescript
// Current styling
className="absolute top-0 bottom-0 w-1 bg-border hover:bg-primary cursor-col-resize z-50"
```

## Common Use Cases

### Main App + Sideview

Show the main app on the left and a detail view on the right:

```typescript
<DualWebviewContainer
  config={{
    leftUrl: 'http://localhost:1420',
    rightUrl: 'http://localhost:1420?sideview=thread:abc123',
    splitRatio: 0.6,
  }}
/>
```

### Two Different Routes

Display two different sections of your app:

```typescript
<DualWebviewContainer
  config={{
    leftUrl: 'http://localhost:1420/emails',
    rightUrl: 'http://localhost:1420/calendar',
    splitRatio: 0.5,
  }}
/>
```

### App + External Content

Embed external content alongside your app:

```typescript
<DualWebviewContainer
  config={{
    leftUrl: 'http://localhost:1420',
    rightUrl: 'https://docs.example.com',
    splitRatio: 0.5,
  }}
/>
```

## Testing

Unit tests are available in `src/hooks/use-dual-webview.test.ts`.

Run tests with:
```bash
bun test use-dual-webview
```

## Troubleshooting

### Webviews not showing

1. Verify you're running in Tauri (check `isTauri()`)
2. Check browser console for errors
3. Ensure URLs are accessible
4. Verify permissions in `capabilities/default.json`

### Resize not working

1. Check that window resize listeners are being attached
2. Verify the debounce timeout is appropriate for your use case
3. Look for errors in the console related to `setSize` or `setPosition`

### Splitter not dragging

1. Ensure `showSplitter={true}` is set
2. Check that mouse events are not being intercepted
3. Verify the splitter has proper z-index layering

## Future Enhancements

Potential improvements:
- Vertical split support (top/bottom)
- Save split preferences to localStorage
- Keyboard shortcuts for split adjustment
- Multi-pane support (more than 2 webviews)
- Programmatic webview focus control

