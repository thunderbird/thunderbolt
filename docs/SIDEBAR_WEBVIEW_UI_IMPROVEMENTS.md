# Sidebar Webview UI Improvements

## ✅ Issues Fixed

### 1. Header Styling ✅

**Before**: Custom header with floating close button  
**After**: Matches main app header with same CSS classes

- Uses `h-12 border-b border-border` classes
- Same height and styling as left sidebar and main content headers
- Consistent visual hierarchy across the app

### 2. Close Button Position ✅

**Before**: Floating overlay button in top-right of content  
**After**: Integrated into header, right-aligned

- Moved to header next to "Preview" title
- Uses same `ghost` variant and `h-7 w-7` sizing as other buttons
- Clean, consistent placement

### 3. Smooth Resize During Drag ✅

**Before**: Webview only updated when drag stopped (50ms debounce)  
**After**: Updates continuously during drag using `requestAnimationFrame`

Changes:

- Replaced `setTimeout` debouncing with `requestAnimationFrame`
- Provides 60fps smooth updates
- No lag when dragging the ResizablePanel handle
- Immediate visual feedback

### 4. Webview Content Area Positioning ✅

**Before**: Webview overlapped the header  
**After**: Webview positioned only in content area

Changes:

- Component uses flex layout with header and content sections
- Container ref now points to content area only (below header)
- Webview fills only the content portion
- Header remains clickable and not covered

### 5. Webview Closing Properly ✅

**Before**: Webview stayed open even after closing sideview  
**After**: Webview closes when component unmounts

Changes:

- Added cleanup in useEffect return
- Properly tracks `isActive` flag
- Calls `webview.close()` in cleanup
- Also closes when config becomes null
- Added console logging for debugging

### 6. Window Move Tracking ✅

**Before**: Webview stayed in same screen position when window moved  
**After**: Webview follows the window automatically

Changes:

- Added `window.onMoved()` event listener
- Updates webview position when window moves
- Also handles `window.onResized()` events
- Uses `requestAnimationFrame` for smooth tracking
- Webview stays perfectly positioned relative to container

## 🎯 Technical Implementation

### Component Structure

```tsx
<div className="flex flex-col h-full">
  {/* Header - matches main app */}
  <header className="flex h-12 w-full items-center justify-between px-4 flex-shrink-0 border-b border-border">
    <span className="text-sm font-medium truncate">Preview</span>
    <Button variant="ghost" size="icon" onClick={handleClose}>
      <X className="h-4 w-4" />
    </Button>
  </header>

  {/* Content area - where webview is positioned */}
  <div ref={contentRef} className="relative flex-1 bg-background overflow-hidden">
    {/* Webview fills this area */}
  </div>
</div>
```

### Hook Improvements

**Event Listeners:**

```ts
// Window resize
unlistenResize = await window.onResized(() => {
  requestPositionUpdate()
})

// Window move
unlistenMove = await window.onMoved(() => {
  requestPositionUpdate()
})

// Container resize
resizeObserver = new ResizeObserver(() => {
  requestPositionUpdate()
})
```

**Animation Frame Updates:**

```ts
const requestPositionUpdate = () => {
  if (animationFrameRef.current) {
    cancelAnimationFrame(animationFrameRef.current)
  }
  animationFrameRef.current = requestAnimationFrame(() => {
    updateWebviewPosition()
  })
}
```

**Proper Cleanup:**

```ts
return () => {
  isActive = false
  cancelAnimationFrame(animationFrameRef.current)
  resizeObserver?.disconnect()
  unlistenResize?.()
  unlistenMove?.()
  webview?.close()
}
```

## 🧪 Testing

All improvements verified:

1. ✅ Header matches main app styling
2. ✅ Close button in header, right-aligned
3. ✅ Smooth resize during drag
4. ✅ Webview doesn't overlap header
5. ✅ Webview closes properly
6. ✅ Webview follows window movement

## 📊 Performance

**Before:**

- 50ms debounced updates
- ~20 updates per second max
- Laggy during drag

**After:**

- `requestAnimationFrame` (16.6ms intervals)
- ~60 updates per second
- Buttery smooth

## 🎨 Visual Consistency

The sidebar webview now matches the app's design system:

| Element       | Style                       |
| ------------- | --------------------------- |
| Header height | `h-12` (48px)               |
| Border        | `border-b border-border`    |
| Padding       | `px-4`                      |
| Text          | `text-sm font-medium`       |
| Close button  | `h-7 w-7` ghost variant     |
| Spacing       | Consistent with main header |

## 🎉 Result

The sidebar webview now:

- ✅ Looks like it belongs in the app
- ✅ Behaves smoothly and predictably
- ✅ Cleans up properly
- ✅ Follows the window perfectly
- ✅ Provides excellent UX
