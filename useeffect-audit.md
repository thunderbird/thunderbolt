# useEffect Audit — Definitive Plan

Every `useEffect` in the codebase, classified into three categories:
1. **REMOVE** — anti-pattern per React docs, can be deleted entirely
2. **REPLACE** — can be replaced with a modern React hook for a better pattern
3. **NECESSARY** — legitimately needs `useEffect`, no better alternative exists

**React version:** `^19.2.1` (all modern hooks available)
**Date:** 2026-03-18
**Total `useEffect` calls:** 104 (in production code)

---

## Quick Stats

| Category | Count | % |
|----------|-------|---|
| REMOVE (delete entirely) | 31 | 30% |
| REPLACE (modern hook) | 18 | 17% |
| NECESSARY (keep useEffect) | 55 | 53% |
| **Total** | **104** | **100%** |

---

## 1. REMOVE — Delete Entirely

These are anti-patterns per [You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect). Each can be eliminated using derived state, event handlers, lazy initializers, `key` prop, or inline computation.

### 1A. State Syncing with Props → Derived State or `key` Prop

> "If you can calculate something during render, you don't need an Effect."

| # | File | Line | What It Does | How to Remove |
|---|------|------|-------------|---------------|
| 1 | `src/settings/preferences.tsx` | 169 | Copies `preferredName.value` into `nameInput` state | Use `preferredName.value` directly as input value. If local editing is needed, use `key={preferredName.value}` on the input wrapper to reset when external value changes. |
| 2 | `src/content-view/message.tsx` | 13 | Copies `defaultIsOpen` prop into `isOpen` state | Use `defaultIsOpen` directly. If the component needs both controlled and uncontrolled behavior, use `key` on the parent to reset. |
| 3 | `src/widgets/weather-forecast/display.tsx` | 17 | Copies `temperature_unit` prop into `temperatureUnit` state | Delete state entirely. Use `temperature_unit` prop directly everywhere. The local state adds no value. |
| 4 | `src/components/chat/reasoning-group-title.tsx` | 16 | Sets `activeIndex` state to `tools.length - 1` | Delete state entirely. Use `const activeIndex = tools.length - 1` as derived value. |
| 5 | `src/components/chat/reasoning-display.tsx` | 28 | Updates `displayText`/`currentKey`/`shouldShow` when `text`/`instanceKey` props change | Use `key={instanceKey}` on the component to reset all internal state when instance changes. Initialize `displayText` from `text` prop. |
| 6 | `src/automations/index.tsx` | 259 | Copies `primaryTrigger?.isEnabled` into `isEnabled` state | Derive from `primaryTrigger` directly: `const isEnabled = primaryTrigger?.isEnabled === 1 \|\| !primaryTrigger`. For optimistic toggle, use `useOptimistic` (see Section 2). |
| 7 | `src/components/onboarding/onboarding-name-step.tsx` | 54 | Copies saved name from settings into form | Initialize form `defaultValues` from settings directly. Don't copy after mount. |

### 1B. Initialization from Already-Available Data → Lazy Initializers

> "If something can be calculated from existing props or state, don't put it in state."

| # | File | Line | What It Does | How to Remove |
|---|------|------|-------------|---------------|
| 8 | `src/hooks/use-onboarding-state.ts` | 227 | Loads saved step from settings on mount | Use `useReducer(reducer, settings, initFn)` — the third argument is a lazy initializer that computes initial state from settings. |
| 9 | `src/hooks/use-onboarding-state.ts` | 235 | Loads name from settings on mount | Same — include in lazy initializer. |
| 10 | `src/hooks/use-onboarding-state.ts` | 242 | Checks provider connected from settings on mount | Same — include in lazy initializer. |
| 11 | `src/hooks/use-oauth-connect.ts` | 149 | Clears expired connecting state from sessionStorage | Move into `useState(() => { /* read/clean sessionStorage */ return initialState })` lazy initializer. |
| 12 | `src/widgets/connect-integration/widget.tsx` | 143 | Restores selected provider from sessionStorage | Same — `useState(() => readSessionStorage())`. |

### 1C. Notifying Parent → Call in Event Handler

> "When you want to notify parent components about state changes, do it in the event handler."

| # | File | Line | What It Does | How to Remove |
|---|------|------|-------------|---------------|
| 13 | `src/components/onboarding/onboarding-location-step.tsx` | 112 | Calls `onFormDirtyChange` when `isFormDirty` changes | Call `onFormDirtyChange` in the handlers that modify form dirty state (onChange, reset, etc.). |
| 14 | `src/components/onboarding/onboarding-name-step.tsx` | 73 | Same pattern | Same fix. |
| 15 | `src/components/chat/markdown-utils.tsx` | 183 | Sets `previewHidden` when dialog opens/closes | Call `setPreviewHidden` in the dialog open/close callbacks. |
| 16 | `src/components/chat/reasoning-display.tsx` | 76 | Resets `shouldShow` when streaming starts again | Fold into the same logic that detects streaming → not streaming transition. Combine with effect at line 45 or handle during render. |

### 1D. Event Handler Logic in Effects → Move to Handler

> "Code that runs because the user did something specific belongs in event handlers, not Effects."

| # | File | Line | What It Does | How to Remove |
|---|------|------|-------------|---------------|
| 17 | `src/settings/mcp-servers.tsx` | 101 | Clears `copiedUrl` after 2s timeout | Move `setTimeout` into the copy click handler: `handleCopy = () => { copy(); setTimeout(() => setCopied(null), 2000) }`. |
| 18 | `src/settings/models/index.tsx` | 229 | Resets form when `isAddDialogOpen` becomes false | Call `form.reset()` inside the close handler (`dispatch({ type: 'CLOSE_DIALOG' })`). |
| 19 | `src/settings/models/index.tsx` | 313 | Fetches models when dialog opens | Fetch models in the open handler. |
| 20 | `src/components/sign-in/sign-in-form.tsx` | 89 | Calls `onEmailSent` on mount if `skipToOtp` is true | Call `onEmailSent` in the parent that decides to skip to OTP, not in the child. |

### 1E. Navigation as Side Effect → `<Navigate>` Component

> "Rendering different components based on some condition is not an Effect."

| # | File | Line | What It Does | How to Remove |
|---|------|------|-------------|---------------|
| 21 | `src/settings/models/layout.tsx` | 28 | Navigates to first model if none selected | Return `<Navigate to={firstModel.id} replace />` in JSX. |

### 1F. Unnecessary Ref Syncing → Assign Directly

> Assigning to `ref.current` during render is safe and doesn't need an Effect.

| # | File | Line | What It Does | How to Remove |
|---|------|------|-------------|---------------|
| 22 | `src/hooks/use-throttle.tsx` | 59 | `callbackRef.current = callback` | Assign in render body. Even better: replace with `useEffectEvent` (see Section 2). |
| 23 | `src/hooks/use-debounce.tsx` | 39 | `callbackRef.current = callback` | Same. |
| 24 | `src/hooks/use-sidebar-resize.ts` | 207 | Updates `autoCollapseThresholdPx` ref | Compute inline where the value is consumed. |
| 25 | `src/lib/mcp-provider.tsx` | 35 | `serversRef.current = servers` | Assign in render body. |
| 26 | `src/components/sign-in/sign-in-form.tsx` | 101 | `goBackRef.current = handleGoBack` | Assign in render body. |
| 27 | `src/devtools/message-simulator.tsx` | 184 | `stopRef.current = handleStop` | Assign in render body. |

### 1G. Redundant Triggers → Simplify Dependency Array

| # | File | Line | What It Does | How to Remove |
|---|------|------|-------------|---------------|
| 28 | `src/components/ui/autosize-textarea.tsx` | 89 | Sets `triggerAutoSize` state when `value` changes | Remove this effect. Add `value` to the first effect's (line 30) dependency array directly. |

### 1H. Derived State Computable During Render

| # | File | Line | What It Does | How to Remove |
|---|------|------|-------------|---------------|
| 29 | `src/tasks/index.tsx` | 286 | Resets `optimisticOrder` when task count changes | Compute during render: `if (!activeId && optimisticOrder.length !== tasks.length) setOptimisticOrder([])` — or better, derive the ordered list in `useMemo` without separate state. |
| 30 | `src/layout/sidebar/index.tsx` | 50 | Stores `location.pathname` in ref if it starts with `/chats/` | Assign ref directly in render body: `if (location.pathname.startsWith('/chats/')) lastChatPathRef.current = location.pathname`. |
| 31 | `src/content-view/context.tsx` | 112 | Calls `showSideview` on mount if `initialSideviewType` and `initialSideviewId` are set | Compute initial state from props: pass `initialSideviewType`/`initialSideviewId` into the initial `useState` value instead of syncing after mount. |

---

## 2. REPLACE — Use a Modern React Hook

These effects work, but a purpose-built React hook provides a cleaner, more idiomatic pattern.

### 2A. `useSyncExternalStore` — Replace Subscription + State

Replaces the `useEffect` + `useState` + `addEventListener`/`subscribe` pattern with a single, SSR-safe hook that guarantees snapshot consistency.

| # | File | Line | What It Does | How to Replace |
|---|------|------|-------------|----------------|
| 32 | `src/hooks/use-mobile.ts` | 8 | `useEffect` subscribes to `matchMedia('(max-width: 767px)')`, updates `isMobile` state | **Textbook case.** `subscribe = (cb) => { mql.addEventListener('change', cb); return () => mql.removeEventListener('change', cb) }`, `getSnapshot = () => mql.matches`. Eliminates effect + state. |
| 33 | `src/lib/theme-provider.tsx` | 71 | `useEffect` subscribes to `prefers-color-scheme` media query | Same pattern as above. `getSnapshot = () => matchMedia('(prefers-color-scheme: dark)').matches`. |
| 34 | `src/hooks/use-powersync-status.ts` | 45 | `useEffect` registers PowerSync SDK status listener, updates state | Wrap PowerSync's `registerListener` into `subscribe`/`getSnapshot` shape. Eliminates manual state management for `isConnected`, `uploading`, `downloading`, `lastSyncedAt`. |

### 2B. `useEffectEvent` — Eliminate Callback Ref Pattern & Dependency Bloat

Creates a stable callback that always reads the latest values without adding to the effect's dependency array. Prevents unnecessary re-synchronization.

| # | File | Line | What It Does | How to Replace |
|---|------|------|-------------|----------------|
| 35 | `src/hooks/use-throttle.tsx` | 14+59 | Throttle effect uses `callbackRef` to keep callback fresh; separate effect syncs ref | Delete the ref-sync effect (#22 above). Replace `callbackRef.current(...)` call inside the timer effect with `useEffectEvent(callback)`. Single effect, no ref. |
| 36 | `src/hooks/use-debounce.tsx` | 12+39 | Same pattern — debounce + callback ref sync | Same fix. Delete ref-sync (#23), use `useEffectEvent(callback)` in timer effect. |
| 37 | `src/hooks/use-handle-integration-completion.ts` | 148 | Event listener with many dependencies (saveMessages, chatThreadId, etc.) | Extract the handler logic into `useEffectEvent`. The event listener only needs setup/teardown once; the handler always reads latest values. Dramatically simplifies dependency array. |
| 38 | `src/chats/use-chat-scroll-handler.ts` | 49 | Scroll on status transition — depends on many values but only needs to re-run on status change | Extract scroll logic into `useEffectEvent`. Effect only watches `status`; scroll behavior reads latest config values. |
| 39 | `src/chats/use-chat-scroll-handler.ts` | 78 | Scroll on first assistant token — same pattern | Same fix. |
| 40 | `src/hooks/use-auto-scroll.tsx` | 211 | Auto-scroll when deps change, reads many config values | Extract scroll decision into `useEffectEvent`. Effect triggers on content changes only. |
| 41 | `src/hooks/use-powersync-credentials-invalid-listener.ts` | 94 | Watches device table, uses refs to avoid stale closures | Replace ref workarounds with `useEffectEvent`. Cleaner than maintaining refs manually. |
| 42 | `src/components/chat/reasoning-display.tsx` | 45 | Fade-out timer reads `shouldShow`, `hasText` etc. | Timer setup only needs to re-run on `isStreaming` change. Other values readable via `useEffectEvent`. |

### 2C. `useTransition` — Replace Manual Loading State

Provides `isPending` automatically and marks updates as non-blocking.

| # | File | Line | What It Does | How to Replace |
|---|------|------|-------------|----------------|
| 43 | `src/settings/mcp-servers.tsx` | 58 | `useEffect` fetches MCP tools, manages loading state | Wrap fetch in `startTransition(async () => { ... })`. `isPending` replaces manual loading flag. |
| 44 | `src/settings/models/index.tsx` | 699 | `useEffect` watches API key/URL changes, fetches models | Wrap `fetchAvailableModels` in `startTransition`. Use `isPending` for loading indicator. |
| 45 | `src/hooks/use-location-search.ts` | 61 | `useEffect` performs debounced API search with manual `isSearching` | Wrap API call in `startTransition`. Combine with `useDeferredValue` for search query display. |

### 2D. `useDeferredValue` — Replace Timer-Based Render Deferral

Device-aware, interruptible rendering deferral. Does NOT replace network debouncing — only render deferral.

| # | File | Line | What It Does | How to Replace |
|---|------|------|-------------|----------------|
| 46 | `src/hooks/use-debounce.tsx` | 12 | Debounce hook delays value updates with `setTimeout` | **Partially replaceable.** When the debounce gates expensive re-renders (not API calls), `useDeferredValue(value)` is better — interruptible, device-aware, no fixed delay. When it gates network requests, keep the timer. Split the hook or provide both APIs. |

### 2E. `useOptimistic` — Replace Manual Optimistic State

Shows immediate UI feedback with automatic rollback on failure.

| # | File | Line | What It Does | How to Replace |
|---|------|------|-------------|----------------|
| 47 | `src/automations/index.tsx` | 259 (already #6 in REMOVE) | Copies `primaryTrigger?.isEnabled` into state for optimistic toggle | Use `useOptimistic(primaryTrigger?.isEnabled === 1)` with `startTransition`. The toggle mutation becomes the action; UI shows toggled state immediately, reverts on failure. Eliminates the sync effect AND the manual state. |
| 48 | `src/tasks/index.tsx` | 286 (already #29 in REMOVE) | Resets optimistic drag order when tasks change | Use `useOptimistic(tasks)` for the ordered list. Drag reorder dispatches optimistic update; when the mutation completes, real data takes over. |

### 2F. `useActionState` — Replace Async Processing with Built-in Pending/Error

| # | File | Line | What It Does | How to Replace |
|---|------|------|-------------|----------------|
| 49 | `src/automations/automation-form-modal.tsx` | 114 | `useEffect` loads trigger data and resets form when modal opens with a prompt | Use `useActionState(loadTriggerData, initialFormState)`. Dispatch when modal opens. `isPending` replaces loading state. Sequential queuing prevents race conditions. |

---

## 3. NECESSARY — Keep `useEffect`

These are legitimate uses of `useEffect` that have no better alternative in React today. They synchronize with external systems, manage DOM operations, handle timers with cleanup, or perform one-time initialization that requires the component to be mounted.

### 3A. External Event Listeners (13 effects)

Subscribe to DOM events, custom events, or platform APIs with proper cleanup.

| # | File | Line | What It Does | Why Necessary |
|---|------|------|-------------|---------------|
| 50 | `src/components/ui/sidebar.tsx` | 127 | Keyboard shortcut (Ctrl/Cmd+B) toggle | DOM `keydown` event. No React API for global keyboard shortcuts. |
| 51 | `src/hooks/use-powersync-credentials-invalid-listener.ts` | 69 | PowerSync credentials invalid event | Custom event from PowerSync SDK. External system notification. |
| 52 | `src/hooks/use-credential-events.ts` | 15 | Revoked device modal event | Custom event subscription for cross-component communication. |
| 53 | `src/hooks/use-sync-enabled-toggle.ts` | 14 | Sync enabled change event | Custom event fired when sync toggled from outside component tree. |
| 54 | `src/hooks/use-deep-link-listener.ts` | 118 | Deep link / app link events | Tauri/Capacitor native API. Entirely external to React. |
| 55 | `src/hooks/use-keyboard-inset.ts` | 19 | Visual Viewport API keyboard show/hide | Browser API subscription. Updates CSS custom property. |
| 56 | `src/hooks/use-safe-area-inset.ts` | 24 | Safe area insets from Tauri | External Tauri API read → CSS property sync. |
| 57 | `src/hooks/use-sidebar-resize.ts` | 260 | Document-level mousemove/mouseup for drag resize | Global DOM event listeners for drag interaction. |
| 58 | `src/hooks/use-oauth-connect.ts` | 169 | Timer to auto-clear connecting state (15s) | Timer with cleanup. Prevents stale "connecting" UI. |
| 59 | `src/hooks/use-auto-scroll.tsx` | 179 | IntersectionObserver for bottom detection | DOM IntersectionObserver API. External to React. |
| 60 | `src/hooks/use-auto-scroll.tsx` | 219 | Cleanup animation frames on unmount | Prevents callbacks firing after unmount. |
| 61 | `src/components/chat/citation-popover.tsx` | 66 | Scroll listener for popover positioning | DOM measurement + scroll event subscription. |
| 62 | `src/hooks/use-handle-integration-completion.ts` | 148 | OAuth completion event + retry (**Note: REPLACE with `useEffectEvent` improves this, but the effect itself stays**) | Custom event subscription with async processing. Effect stays, but handler extracted via `useEffectEvent`. |

### 3B. External System Subscriptions (8 effects)

Synchronize with external systems: PowerSync, MCP, browser APIs, localStorage.

| # | File | Line | What It Does | Why Necessary |
|---|------|------|-------------|---------------|
| 63 | `src/hooks/use-mcp-sync.tsx` | 18 | Syncs DB MCP servers with MCP provider context | Bidirectional sync between database and MCP provider. Two external systems. |
| 64 | `src/lib/theme-provider.tsx` | 38 | Persists theme to localStorage | External storage write. |
| 65 | `src/lib/theme-provider.tsx` | 42 | Applies theme to DOM (classes, meta tags, Tauri bar) | DOM mutations outside React's VDOM. |
| 66 | `src/hooks/use-local-storage.ts` | 21 | Flushes pending localStorage writes on key change | External storage sync with cleanup. |
| 67 | `src/lib/mcp-provider.tsx` | 169 | Cleanup MCP connections on unmount | Closes WebSocket/SSE connections. Essential resource cleanup. |
| 68 | `src/settings/integrations.tsx` | 146 | Processes OAuth callback from location.state | Router state is external. OAuth data arrives via navigation. |
| 69 | `src/components/onboarding/onboarding-auth-step.tsx` | 53 | Processes OAuth callback from location.state | Same — router state triggers OAuth flow. |
| 70 | `src/widgets/connect-integration/widget.tsx` | 150 | OAuth callback from location.state | Same pattern. |

### 3C. DOM Measurements & Scroll (8 effects)

Read from or write to the DOM in ways React can't handle declaratively. Must happen after render.

| # | File | Line | What It Does | Why Necessary |
|---|------|------|-------------|---------------|
| 71 | `src/components/ui/autosize-textarea.tsx` | 30 | Measures `scrollHeight`, applies height | DOM measurement → style mutation. |
| 72 | `src/chats/use-chat-scroll-handler.ts` | 49 | Scroll on user message submit (**`useEffectEvent` improves handler**) | DOM scroll tied to status transitions. |
| 73 | `src/chats/use-chat-scroll-handler.ts` | 78 | Scroll on first assistant token (**`useEffectEvent` improves handler**) | DOM scroll tied to streaming state. |
| 74 | `src/hooks/use-auto-scroll.tsx` | 211 | Auto-scroll when deps change (**`useEffectEvent` improves handler**) | DOM scroll triggered by content changes. |
| 75 | `src/components/ui/mobile-sidebar.tsx` | 40 | Animate sidebar open/close with spring | Framer Motion imperative `animate()` API. DOM animation. |
| 76 | `src/components/chat/chat-ui.tsx` | 38 | Scroll to bottom on chat entry | DOM scroll on mount. One-time with ref guard. |
| 77 | `src/layout/main-layout.tsx` | 35 | Animates content view width on open/close | DOM animation via Framer Motion `animate()`. |
| 78 | `src/content-view/use-sidebar-webview.ts` | 33 | Creates Tauri webview, positions/resizes via ResizeObserver | Tauri native webview lifecycle management. DOM measurement for positioning. |

### 3D. Timers with Cleanup (7 effects)

Create timers that must be cleaned up. Timers are external to React's render cycle.

| # | File | Line | What It Does | Why Necessary |
|---|------|------|-------------|---------------|
| 79 | `src/hooks/use-throttle.tsx` | 14 | Throttle timer (**`useEffectEvent` eliminates companion ref-sync effect**) | Core throttling mechanism with cleanup. |
| 80 | `src/hooks/use-throttle.tsx` | 64 | Cleanup timeout on unmount | Prevents memory leak. |
| 81 | `src/hooks/use-debounce.tsx` | 12 | Debounce timer (**`useEffectEvent` eliminates companion ref-sync effect**) | Core debouncing mechanism with cleanup. |
| 82 | `src/hooks/use-debounce.tsx` | 44 | Cleanup timeout on unmount | Prevents memory leak. |
| 83 | `src/hooks/use-desktop-update.ts` | 123 | Delayed update check (5s) | Timer-gated async operation on desktop only. |
| 84 | `src/components/ui/action-feedback-button.tsx` | 34 | Cleanup timeout on unmount | Prevents setState after unmount. |
| 85 | `src/components/chat/reasoning-display.tsx` | 45 | Fade-out timer (**`useEffectEvent` simplifies deps**) | Timer-based animation with min display time. |

### 3E. Analytics & Page Tracking (2 effects)

Fire analytics when component is displayed. "Component was displayed" is the canonical effect use case.

| # | File | Line | What It Does | Why Necessary |
|---|------|------|-------------|---------------|
| 86 | `src/hooks/use-analytics.tsx` | 14 | Track page views/leaves on route change | Analytics side effect. Cleanup fires "page left" event. |
| 87 | `src/hooks/use-analytics.tsx` | 31 | Track page leave on final unmount | Ensures final analytics event fires. |

### 3F. Async Operations on Mount/Dependency Change (10 effects)

Trigger async operations when component is displayed or external data changes. These are valid "synchronize with external system" patterns.

| # | File | Line | What It Does | Why Necessary |
|---|------|------|-------------|---------------|
| 88 | `src/hooks/use-app-initialization.ts` | 207 | Initialize database, tray, PostHog on mount | One-time async initialization of multiple external systems. |
| 89 | `src/chats/detail.tsx` | 19 | Hydrate chat store when chat ID changes | Loads chat history from database. External data source. |
| 90 | `src/chats/save-partial-assistant-messages-handler.ts` | 34 | Throttled save of streaming messages | Persists to database during streaming. External write. |
| 91 | `src/chats/use-chat-automation.tsx` | 19 | Auto-regenerate if last message is user | Triggers async `regenerate()`. External chat SDK operation. |
| 92 | `src/components/magic-link-verify.tsx` | 38 | Verify OTP from URL params | External URL params → async auth verification. |
| 93 | `src/components/oauth-callback.tsx` | 9 | Process OAuth params, redirect | Reads URL params, communicates with parent window. |
| 94 | `src/settings/models/detail.tsx` | 109 | `form.reset()` when model data changes | react-hook-form requires explicit reset. Library integration. |
| 95 | `src/content-view/use-sidebar-webview.ts` | 200 | Hide/show native webview when `hidden` prop changes | Tauri native API calls (`.hide()`/`.show()`). External system. |
| 96 | `src/automations/use-trigger-scheduler.ts` | 12 | Schedule automation triggers, set up interval | Timer + async operations for scheduled automations. External system. |
| 97 | `src/components/chat/chat-messages.tsx` | 32 | Haptic feedback when streaming completes | Native haptic vibration. External to React. |

### 3G. Form Library Subscriptions (4 effects)

react-hook-form's `watch()` returns a subscription requiring effect-based cleanup.

| # | File | Line | What It Does | Why Necessary |
|---|------|------|-------------|---------------|
| 98 | `src/settings/models/index.tsx` | 666 | Watch provider changes, reset dependent fields | RHF subscription with cleanup. Library integration. |
| 99 | `src/components/onboarding/onboarding-location-step.tsx` | 94 | form.watch() for location validation | RHF subscription with cleanup. |
| 100 | `src/components/onboarding/onboarding-name-step.tsx` | 60 | form.watch() for name validation | RHF subscription with cleanup. |
| 101 | `src/content-view/context.tsx` | 119 | Close content view when crossing into mobile | Responds to breakpoint transition (not continuously). External viewport state. |

### 3H. Mount Initialization — DOM Focus / Platform (3 effects)

One-time DOM operations that require the element to be rendered.

| # | File | Line | What It Does | Why Necessary |
|---|------|------|-------------|---------------|
| 102 | `src/components/onboarding/onboarding-location-step.tsx` | 85 | Focus search input on mount | DOM focus requires element to exist. |
| 103 | `src/components/onboarding/onboarding-name-step.tsx` | 48 | Focus name input on mount | DOM focus. |
| 104 | `src/components/sign-in/sign-in-form.tsx` | 108 | Auto-focus email on desktop (skip mobile) | Conditional DOM focus. `autoFocus` doesn't support conditional logic. |

### Remaining effects in NECESSARY (accounted for above but listed for completeness)

| File | Line | Category |
|------|------|----------|
| `src/settings/preferences.tsx` | 174 | 3F — Auto-populate localization after async country data loads |
| `src/components/onboarding/onboarding-dialog.tsx` | 23 | 3F — Open dialog after async settings load |
| `src/components/onboarding/onboarding-location-step.tsx` | 116 | 3H — Initialize form state on mount |
| `src/components/onboarding/onboarding-name-step.tsx` | 77 | 3H — Initialize form state on mount |
| `src/layout/sidebar/index.tsx` | 56 | 3H — Focus search input after toggle |
| `src/devtools/message-simulator.tsx` | 154 | 3F — Auto-start simulation on mount |
| `src/devtools/message-simulator.tsx` | 168 | 3F — Monitor simulation completion |
| `src/tasks/index.tsx` | 97 | 3H — Focus input when editing starts |
| `src/tasks/index.tsx` | 198 | 3H — Focus new task input on mount |

---

## Implementation Plan

### Phase 1 — Quick Deletions (no new patterns, just remove code)

**Effects removed: 15** | **Risk: Low** | **Effort: Small**

| What | Effects | How |
|------|---------|-----|
| Delete ref-syncing effects | #22–27 | Remove effects, assign refs in render body |
| Delete derived state effects | #4, #6 | Replace `useState` + `useEffect` with inline `const` |
| Delete prop-copying effects | #3 | Delete state, use prop directly |
| Delete redundant trigger | #28 | Remove effect, update dep array on line-30 effect |
| Delete ref assignment in render | #30 | Move assignment to render body |

### Phase 2 — Lazy Initializers (delete effects, move logic to init)

**Effects removed: 5** | **Risk: Low** | **Effort: Small**

| What | Effects | How |
|------|---------|-----|
| Onboarding state init | #8, #9, #10 | `useReducer(reducer, settings, computeInitialState)` |
| OAuth sessionStorage init | #11, #12 | `useState(() => readAndCleanSessionStorage())` |

### Phase 3 — Move to Event Handlers

**Effects removed: 6** | **Risk: Medium** | **Effort: Medium**

| What | Effects | How |
|------|---------|-----|
| Timeout in copy handler | #17 | `handleCopy = () => { copy(); setTimeout(clear, 2000) }` |
| Form reset in dialog close | #18, #19 | Call in `CLOSE_DIALOG`/open dispatch |
| Parent notifications | #13, #14, #15 | Call callbacks directly in onChange/reset handlers |

### Phase 4 — `useSyncExternalStore`

**Effects replaced: 3** | **Risk: Medium** | **Effort: Medium**

| What | Effects | How |
|------|---------|-----|
| `use-mobile.ts` | #32 | `subscribe`/`getSnapshot` wrapping `matchMedia` |
| `theme-provider.tsx` | #33 | Same pattern for `prefers-color-scheme` |
| `use-powersync-status.ts` | #34 | Wrap PowerSync listener into snapshot API |

### Phase 5 — `useEffectEvent` Adoption

**Effects improved: 8** (effects stay but become simpler) | **Risk: Medium** | **Effort: Medium**

| What | Effects | How |
|------|---------|-----|
| Throttle/debounce callback | #35, #36 | Replace `callbackRef` pattern with `useEffectEvent(callback)` |
| Integration completion handler | #37 | Extract handler into `useEffectEvent`, simplify deps |
| Scroll handlers | #38, #39, #40 | Extract scroll logic into `useEffectEvent` |
| PowerSync device watcher | #41 | Replace ref workarounds with `useEffectEvent` |
| Reasoning fade timer | #42 | Only re-run on `isStreaming` change |

### Phase 6 — `useTransition` + `useDeferredValue`

**Effects replaced: 3** | **Risk: Medium** | **Effort: Medium**

| What | Effects | How |
|------|---------|-----|
| MCP tools fetch | #43 | `startTransition(async () => { fetchTools() })` |
| Models fetch on credentials change | #44 | `startTransition(async () => { fetchModels() })` |
| Location search | #45 | `startTransition` + `useDeferredValue` for results display |

### Phase 7 — Structural Changes (key prop, Navigate, useOptimistic, useActionState)

**Effects removed/replaced: 8** | **Risk: Higher** | **Effort: Larger**

| What | Effects | How |
|------|---------|-----|
| Key prop resets | #1, #2, #5, #7 | Add `key={id}` to parent, remove sync effects |
| `<Navigate>` | #21 | Return `<Navigate>` in JSX |
| `useOptimistic` | #47, #48 | Replace manual optimistic state |
| `useActionState` | #49 | Replace modal load-on-open effect |
| Skip-to-OTP notification | #20 | Move to parent |
| Compute initial sideview | #31 | Use initial state instead of mount effect |
| Derived dirty state | #16 | Combine with streaming state logic |
| `useDeferredValue` evaluation | #46 | Split debounce hook for render vs network cases |

---

## Verification

After each phase:
1. `bun run thundercheck` — type-check + lint + format
2. `bun test` — unit tests
3. Manual smoke test: onboarding, settings, chat, sidebar, OAuth flow
4. Check React DevTools for unexpected re-renders in modified components
5. Verify no regressions in scroll behavior (chat, auto-scroll)

---

## After All Phases

| Metric | Before | After |
|--------|--------|-------|
| Total `useEffect` calls | 104 | ~55 |
| Effects in component files | ~60 | ~25 (rest extracted to hooks) |
| Manual ref-syncing effects | 6 | 0 |
| Prop-syncing effects | 7 | 0 |
| Manual subscription effects replaceable by `useSyncExternalStore` | 3 | 0 |
| Effects improved by `useEffectEvent` | 0 | 8 |

**Irreducible core:** ~55 effects that legitimately synchronize with external systems — exactly what `useEffect` was designed for.
