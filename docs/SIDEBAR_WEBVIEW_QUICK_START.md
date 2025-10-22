# Sidebar Webview - Quick Start

Show a full-size webview in your right sidebar when clicking preview links.

## 🎯 Quick Example

```tsx
import { SidebarWebview } from '@/components/sidebar-webview'
import { useState } from 'react'

function MySidebar() {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  return previewUrl ? (
    <SidebarWebview
      config={{ url: previewUrl }}
      onClose={() => setPreviewUrl(null)}
    />
  ) : (
    <div>
      <button onClick={() => setPreviewUrl('https://example.com')}>
        Preview Link
      </button>
    </div>
  )
}
```

## 📁 What Was Created

1. **`src/hooks/use-sidebar-webview.ts`** - Core logic
2. **`src/components/sidebar-webview.tsx`** - UI component  
3. **`src/layout/sideview-with-webview.tsx`** - Integration example
4. **Tests** - Full test coverage ✅
5. **Documentation** - This guide + full guide

## ⚡ How It Works

1. Component tracks sidebar container with a ref
2. Creates webview positioned over container
3. ResizeObserver automatically updates on resize
4. Close button allows user to exit preview

## 🚀 Integration Steps

### Step 1: Add State for Preview URL

```tsx
const [previewUrl, setPreviewUrl] = useState<string | null>(null)
```

### Step 2: Show Webview When URL is Set

```tsx
import { SidebarWebview } from '@/components/sidebar-webview'

{previewUrl ? (
  <SidebarWebview
    config={{ url: previewUrl }}
    onClose={() => setPreviewUrl(null)}
  />
) : (
  // Your regular sidebar content
)}
```

### Step 3: Trigger Preview on Click

```tsx
<a onClick={() => setPreviewUrl('https://example.com')}>
  Preview
</a>
```

## ✨ Features

- ✅ Full-size webview in sidebar
- ✅ Automatic resize with sidebar
- ✅ Close button overlay
- ✅ Loading states
- ✅ Platform detection
- ✅ Type-safe API

## 🔒 Permissions

Already configured (same as dual webview):
- ✅ `core:webview:allow-create-webview-window`
- ✅ `core:webview:allow-webview-size`
- ✅ `core:webview:allow-webview-position`

## 💡 Use Cases

### Email Preview
```tsx
<button onClick={() => setPreviewUrl(`https://mail.app/email/${id}`)}>
  View Email
</button>
```

### Document Preview
```tsx
<button onClick={() => setPreviewUrl(`https://docs.app/doc/${id}`)}>
  Open Document
</button>
```

### External Link
```tsx
<a onClick={() => setPreviewUrl('https://example.com')}>
  Preview Website
</a>
```

## 🖥️ Platform Support

- ✅ macOS, Windows, Linux
- ❌ Web, iOS, Android (desktop only)

## 🧪 Testing

```bash
bun test sidebar-webview
```

## 📚 Full Documentation

See **[sidebar-webview-guide.md](./sidebar-webview-guide.md)** for:
- Advanced usage
- Troubleshooting
- Best practices
- Integration examples

## ❓ Common Questions

**Q: Can I show multiple webviews?**  
A: For multiple webviews, use the dual webview feature instead.

**Q: Does it work in the web browser?**  
A: No, Tauri desktop only. It shows a helpful message on web.

**Q: Will it resize when I drag the sidebar?**  
A: Yes! ResizeObserver automatically tracks and updates.

**Q: How do I close it programmatically?**  
A: Set the config to null: `setPreviewUrl(null)`

## 🎉 You're Ready!

That's it! You now have a working sidebar webview for previewing content.

Try it out:
1. Add state for preview URL
2. Render `<SidebarWebview>` conditionally
3. Set URL when user clicks preview
4. User can close with X button

