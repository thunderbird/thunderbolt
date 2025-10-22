# Webview Features Overview

This document provides an overview of all webview features implemented in Thunderbolt.

## 📦 What's Available

You now have **two powerful webview features**:

### 1. Sidebar Preview Webview ⭐ (Recommended for most use cases)

**Purpose**: Show web content when clicking preview links

**Best for**:

- Link preview widgets (✅ Already integrated!)
- Email previews
- Document previews
- Any single preview content

**Key Features**:

- ✅ Automatic for link preview clicks
- ✅ Fills sidebar panel completely
- ✅ Auto-resizes with sidebar
- ✅ Simple integration (Context API)
- ✅ Platform detection built-in

**Docs**: `docs/PREVIEW_LINKS_IMPLEMENTATION.md`

---

### 2. Dual Webview

**Purpose**: Split screen with two independent webviews side-by-side

**Best for**:

- Split-screen layouts
- Comparing two pages
- Main app + reference material
- Custom multi-pane views

**Key Features**:

- ✅ Two real webviews
- ✅ Draggable splitter
- ✅ Custom split ratios
- ✅ Independent URLs per pane

**Docs**:

- Quick Start: `docs/dual-webview-quick-start.md`
- Full Guide: `docs/dual-webview-guide.md`
- Summary: `docs/DUAL_WEBVIEW_SUMMARY.md`

## 🎯 Quick Decision Guide

**Use Sidebar Preview if you want to:**

- Show previews when users click links → **Already done!**
- Display content in the existing sidebar
- Keep it simple

**Use Dual Webview if you need:**

- Two webviews simultaneously
- Custom split layouts
- More control over positioning

## 📁 File Structure

```
src/
├── contexts/
│   └── preview-context.tsx           # Global preview management
├── hooks/
│   ├── use-sidebar-webview.ts        # Sidebar webview hook
│   └── use-dual-webview.ts          # Dual webview hook
├── components/
│   ├── sidebar-webview.tsx           # Sidebar webview component
│   └── dual-webview-container.tsx    # Dual webview component
├── layout/
│   ├── main-layout.tsx              # ✅ Preview integration
│   ├── sideview.tsx                 # Regular sideview
│   ├── sideview-dual.tsx           # Dual webview example
│   └── sideview-with-webview.tsx   # Sidebar webview example
├── widgets/
│   └── link-preview/
│       └── display.tsx              # ✅ Click interception
└── pages/
    └── dual-webview-example.tsx    # Dual webview demo

src-tauri/
└── capabilities/
    └── default.json                 # ✅ Permissions configured
```

## ✨ Current Status

### Sidebar Preview Webview

- ✅ **Implemented and integrated**
- ✅ Link preview widgets automatically use it
- ✅ Works in Tauri desktop app
- ✅ Falls back to browser on web/mobile
- ✅ All tests passing
- ✅ No changes needed - ready to use!

### Dual Webview

- ✅ **Implemented and ready**
- ✅ Full test coverage
- ✅ Documentation complete
- ⚠️ Not auto-integrated (use when needed)
- ✅ Examples provided

## 🚀 Usage

### Sidebar Preview (Already Working!)

**No code needed - it just works!**

1. Run app: `bun tauri:dev`
2. Ask AI: "Show me today's top news"
3. Click any preview card
4. Boom! Opens in sidebar 🎉

**To use programmatically:**

```tsx
import { usePreview } from '@/contexts/preview-context'

const { showPreview } = usePreview()
showPreview('https://example.com')
```

### Dual Webview (Manual setup)

```tsx
import { DualWebviewContainer } from '@/components/dual-webview-container'
;<DualWebviewContainer
  config={{
    leftUrl: 'http://localhost:1420',
    rightUrl: 'https://example.com',
    splitRatio: 0.5,
  }}
  showSplitter={true}
/>
```

## 🔒 Permissions

All required permissions are configured in `src-tauri/capabilities/default.json`:

```json
"permissions": [
  "core:webview:allow-create-webview-window",
  "core:webview:allow-webview-size",
  "core:webview:allow-webview-position"
]
```

## 🧪 Testing

Run all webview tests:

```bash
bun test webview       # All webview tests
bun test sidebar       # Sidebar webview only
bun test dual-webview  # Dual webview only
```

All tests passing: ✅

## 🖥️ Platform Support

| Feature         | macOS | Windows | Linux | Web       | Mobile    |
| --------------- | ----- | ------- | ----- | --------- | --------- |
| Sidebar Preview | ✅    | ✅      | ✅    | Browser\* | Browser\* |
| Dual Webview    | ✅    | ✅      | ✅    | ❌        | ❌        |

\* Falls back to opening links in browser

## 📚 Documentation Index

1. **[PREVIEW_LINKS_IMPLEMENTATION.md](./PREVIEW_LINKS_IMPLEMENTATION.md)**
   - How preview links work in sidebar
   - Integration details
   - User and developer guides

2. **[sidebar-webview-guide.md](./sidebar-webview-guide.md)**
   - Complete sidebar webview guide
   - API reference
   - Troubleshooting

3. **[SIDEBAR_WEBVIEW_QUICK_START.md](./SIDEBAR_WEBVIEW_QUICK_START.md)**
   - Quick reference
   - Code examples
   - Common patterns

4. **[DUAL_WEBVIEW_SUMMARY.md](./DUAL_WEBVIEW_SUMMARY.md)**
   - Complete dual webview overview
   - Implementation summary
   - All features documented

5. **[dual-webview-guide.md](./dual-webview-guide.md)**
   - Comprehensive dual webview guide
   - Architecture details
   - Advanced usage

6. **[dual-webview-quick-start.md](./dual-webview-quick-start.md)**
   - Quick start guide
   - Code examples
   - Common use cases

## 🎉 Summary

You now have two powerful webview systems:

1. **Sidebar Preview** - ✅ Already working for link previews!
   - Zero setup needed
   - Just click links
   - They open in sidebar

2. **Dual Webview** - Ready when you need it
   - For split-screen layouts
   - Full documentation available
   - Easy to integrate

Both features:

- ✅ Fully tested
- ✅ Type-safe
- ✅ Well documented
- ✅ Production ready

## 🤝 Contributing

When adding new preview types:

1. Use `usePreview()` hook
2. Call `showPreview(url)` on click
3. That's it! The system handles the rest

When creating custom layouts:

- Consider dual webview for side-by-side views
- Consider sidebar webview for single previews

## ❓ Questions?

- **How do I show a preview?** → Use `usePreview()` hook
- **How do I customize?** → See individual guides
- **Having issues?** → Check troubleshooting sections
- **Need both webviews?** → They work together!

## 🎊 That's It!

Your preview links now open in a beautiful sidebar webview. Enjoy! 🚀
