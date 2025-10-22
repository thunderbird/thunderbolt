# Preview Links in Sidebar - Implementation Summary

## ✅ Problem Solved

**Issue**: When clicking preview link widgets, they were opening in the browser instead of the sidebar.

**Solution**: Intercept link clicks in Tauri desktop app and show them in a webview that fills the right sidebar panel.

## 🎯 What Was Implemented

### 1. Preview Context (`src/contexts/preview-context.tsx`)

Global context for managing webview previews without prop drilling.

```tsx
const { showPreview, closePreview, isPreviewOpen } = usePreview()

// Show a preview
showPreview('https://example.com')

// Close it
closePreview()
```

### 2. Updated Link Preview Widget

Modified `src/widgets/link-preview/display.tsx` to:

- Check if running in Tauri desktop app
- Intercept clicks with `preventDefault()`
- Call `showPreview(url)` instead of opening browser
- Falls back to browser on web/mobile

```tsx
const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
  if (isDesktop) {
    e.preventDefault()
    showPreview(url) // Show in sidebar webview
  }
  // Otherwise, let default <a> behavior happen
}
```

### 3. Integrated with Main Layout

Updated `src/layout/main-layout.tsx` to:

- Show sidebar when preview is open OR sideview is active
- Display `SidebarWebview` component when preview is active
- Handle close actions for both preview and sideview

### 4. Wrapped App with PreviewProvider

Added `PreviewProvider` to `src/app.tsx` provider tree so all components can access preview functionality.

## 📦 Files Modified

1. **Created:**
   - `src/contexts/preview-context.tsx` - Global preview management
   - `src/hooks/use-sidebar-webview.ts` - Webview lifecycle hook
   - `src/components/sidebar-webview.tsx` - Webview UI component
   - Tests and documentation

2. **Modified:**
   - `src/widgets/link-preview/display.tsx` - Intercept clicks
   - `src/layout/main-layout.tsx` - Show webview in sidebar
   - `src/app.tsx` - Add PreviewProvider

## 🚀 How It Works

### User Experience Flow

1. User asks AI: "Show me today's top news"
2. AI responds with `<widget:link-preview>` tags
3. Link preview cards render in the chat
4. User clicks a preview card
5. **Desktop App**: Sidebar opens with full webview showing the page
6. **Web/Mobile**: Link opens in browser (fallback)
7. User can:
   - View the full page in the sidebar
   - Resize the sidebar by dragging
   - Close with X button or collapse icon
   - Continue chatting while viewing

### Technical Flow

```
User clicks link preview
        ↓
LinkPreview.handleClick()
        ↓
Check isTauri()
        ↓
    Desktop?
   ↙      ↘
 Yes       No
  ↓         ↓
preventDefault()  Default behavior
  ↓         (open in browser)
showPreview(url)
  ↓
PreviewContext updates
  ↓
Main layout re-renders
  ↓
Shows SidebarWebview
  ↓
Hook creates Webview
  ↓
Webview fills sidebar
```

## ✨ Features

### Automatic Positioning

- Webview tracks sidebar container with `ResizeObserver`
- Updates position/size when sidebar resizes
- Smooth with 50ms debouncing

### Platform Detection

- Works only in Tauri desktop app
- Auto-falls back to browser on web/mobile
- Shows helpful message when unavailable

### Seamless Integration

- No prop drilling needed (uses Context)
- Works with existing ResizablePanel system
- Closes when sidebar collapses
- Coexists with sideview feature

### User Controls

- X button overlay for easy closing
- Sidebar drag handle still works
- Collapse icon closes both preview and sidebar

## 🧪 Testing

All tests passing:

```bash
bun test sidebar-webview  # ✅ 3 tests
bun test dual-webview     # ✅ 6 tests
```

TypeScript compilation: ✅ No errors

## 📋 Permissions

Already configured in `src-tauri/capabilities/default.json`:

- ✅ `core:webview:allow-create-webview-window`
- ✅ `core:webview:allow-webview-size`
- ✅ `core:webview:allow-webview-position`

## 🖥️ Platform Support

| Platform | Behavior                   |
| -------- | -------------------------- |
| macOS    | ✅ Show in sidebar webview |
| Windows  | ✅ Show in sidebar webview |
| Linux    | ✅ Show in sidebar webview |
| Web      | Falls back to browser      |
| iOS      | Falls back to browser      |
| Android  | Falls back to browser      |

## 💡 Usage Examples

### As a User

1. **Ask AI for links:**

   ```
   "Show me the top 3 tech news stories"
   "Find me the best robot vacuum reviews"
   "What are the new movies out this week?"
   ```

2. **Click any preview card**

3. **View in sidebar:**
   - Full webpage loads in sidebar
   - Continue chatting on the left
   - Resize sidebar as needed
   - Close when done

### As a Developer

**Use preview globally:**

```tsx
import { usePreview } from '@/contexts/preview-context'

function MyComponent() {
  const { showPreview } = usePreview()

  return <button onClick={() => showPreview('https://example.com')}>Show Preview</button>
}
```

**Check if preview is open:**

```tsx
const { isPreviewOpen } = usePreview()

if (isPreviewOpen) {
  // Show different UI
}
```

**Close programmatically:**

```tsx
const { closePreview } = usePreview()

closePreview()
```

## 🔧 How It's Different from Dual Webview

| Feature     | Preview in Sidebar  | Dual Webview        |
| ----------- | ------------------- | ------------------- |
| Purpose     | Show one preview    | Split-screen layout |
| Webviews    | 1                   | 2                   |
| Trigger     | Click link widget   | Manual setup        |
| Layout      | Fills sidebar panel | Custom positioning  |
| Integration | Drop-in (Context)   | Component-based     |
| Complexity  | Simple              | More complex        |

## 🎉 Summary

You can now click preview link widgets and they'll open in a sidebar webview instead of your browser! The feature:

- ✅ Works automatically for all link preview widgets
- ✅ No changes needed to existing code
- ✅ Falls back gracefully on web/mobile
- ✅ Integrates seamlessly with existing UI
- ✅ Provides great user experience
- ✅ Fully tested and type-safe

## 🚀 Try It Out

1. Run your Tauri app: `bun tauri:dev`
2. Ask the AI: "Show me today's top news"
3. Click any link preview card
4. Watch it open in the sidebar! 🎊

The sidebar will open automatically with a full webview showing the page, and you can continue chatting while viewing the content.
