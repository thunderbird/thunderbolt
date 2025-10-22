# Dual Webview Quick Start

This is a quick guide to get you started with dual webviews in Thunderbolt.

## 🎯 Quick Example

```tsx
import { DualWebviewContainer } from '@/components/dual-webview-container'

function MyComponent() {
  return (
    <DualWebviewContainer
      config={{
        leftUrl: 'http://localhost:1420',
        rightUrl: 'http://localhost:1420/settings',
        splitRatio: 0.5, // 50/50 split
      }}
      showSplitter={true}
    />
  )
}
```

## 📁 Files Created

- **Hook**: `src/hooks/use-dual-webview.ts` - Core logic for managing webviews
- **Component**: `src/components/dual-webview-container.tsx` - UI wrapper with draggable splitter
- **Example**: `src/pages/dual-webview-example.tsx` - Working example
- **Alternative**: `src/layout/sideview-dual.tsx` - Alternative sideview implementation
- **Tests**: `src/hooks/use-dual-webview.test.ts` - Unit tests

## ⚡ How It Works

1. **Creates two real webviews** side-by-side in a single window
2. **Each webview** takes up a configurable portion of the window (default 50/50)
3. **Draggable splitter** allows users to resize the panes
4. **Automatically handles** window resize events

## 🎨 Customization

### Change Split Ratio

```tsx
// 60% left, 40% right
<DualWebviewContainer config={{ leftUrl: '...', rightUrl: '...', splitRatio: 0.6 }} />
```

### Disable Splitter

```tsx
// Fixed split, no user resizing
<DualWebviewContainer config={{ leftUrl: '...', rightUrl: '...' }} showSplitter={false} />
```

### Dynamic Split Updates

```tsx
const { updateSplitRatio } = useDualWebview(config)

// Later in your code:
updateSplitRatio(0.7) // Change to 70/30 split
```

## 🔒 Permissions

Already configured in `src-tauri/capabilities/default.json`:

- ✅ `core:webview:allow-create-webview-window`
- ✅ `core:webview:allow-webview-size`
- ✅ `core:webview:allow-webview-position`
- ✅ `core:window:allow-create`

## 🖥️ Platform Support

- ✅ **macOS** - Fully supported
- ✅ **Windows** - Fully supported
- ✅ **Linux** - Fully supported
- ❌ **Web** - Not available (Tauri only)
- ❌ **iOS/Android** - Not available (desktop only)

## 🔍 Use Cases

### Main App + Detail View

```tsx
<DualWebviewContainer
  config={{
    leftUrl: 'http://localhost:1420',
    rightUrl: 'http://localhost:1420?sideview=thread:123',
  }}
/>
```

### Split Routes

```tsx
<DualWebviewContainer
  config={{
    leftUrl: 'http://localhost:1420/emails',
    rightUrl: 'http://localhost:1420/calendar',
  }}
/>
```

### App + External Content

```tsx
<DualWebviewContainer
  config={{
    leftUrl: 'http://localhost:1420',
    rightUrl: 'https://docs.example.com',
  }}
/>
```

## 🧪 Testing

Run the tests:

```bash
bun test use-dual-webview
```

## 📚 More Documentation

For detailed documentation, see [dual-webview-guide.md](./dual-webview-guide.md)

## 🚀 Try It Out

To see a working example:

1. Create a route that uses `DualWebviewExample` component
2. Navigate to it in your Tauri app
3. You'll see two webviews side-by-side with a draggable splitter!

## ❓ Troubleshooting

**Webviews not showing?**

- Make sure you're running in Tauri (check with `isTauri()`)
- Check console for errors
- Verify URLs are accessible

**Splitter not working?**

- Ensure `showSplitter={true}` is set
- Check that mouse events aren't being intercepted
- Verify z-index layering in the CSS

**Need Help?**
See the full guide: [docs/dual-webview-guide.md](./dual-webview-guide.md)
