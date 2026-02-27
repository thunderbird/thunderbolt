# localStorage Security Fix - Production Blank Screen Issue

## Problem

The production app was showing a blank screen with the error:
```
Uncaught DOMException: The operation is insecure.
```

This error occurs when code tries to access `localStorage` in contexts where it's not allowed:
- HTTP contexts (instead of HTTPS)
- Restrictive iframe sandbox attributes
- Third-party storage blocked by browser
- Private/incognito mode with strict security policies

## Root Cause

Multiple parts of the codebase accessed `localStorage` without error handling:

1. **ThemeProvider** (`src/lib/theme-provider.tsx`)
   - Wraps the entire app
   - Unhandled localStorage error → React error boundary → blank screen

2. **PowerSync Database** (`src/db/powersync/database.ts`)
   - Sync preferences stored in localStorage
   - No error handling for storage access

3. **PostHog Analytics** (`src/lib/posthog.tsx`)
   - Configured with `persistence: 'localStorage'`
   - Failed initialization → error loop → rate limiting

4. **Auth Token Storage** (`src/lib/auth-token.ts`)
   - Critical auth tokens stored in localStorage
   - No fallback when storage unavailable

5. **Credentials Reset** (`src/hooks/use-powersync-credentials-invalid-listener.ts`)
   - `localStorage.clear()` without error handling

## Solution

### 1. ThemeProvider - Graceful Degradation
```typescript
// Before: Direct localStorage access
const savedTheme = window.localStorage.getItem(storageKey)

// After: Try-catch with fallback
const savedTheme = (() => {
  try {
    return window.localStorage.getItem(storageKey)
  } catch {
    return null // Fall back to default theme
  }
})()
```

### 2. PowerSync Database - Safe Storage Access
```typescript
// Before: Only checked if undefined
export const isSyncEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') return false
  return localStorage.getItem(syncEnabledKey) === 'true'
}

// After: Try-catch for access errors
export const isSyncEnabled = (): boolean => {
  try {
    if (typeof localStorage === 'undefined') return false
    return localStorage.getItem(syncEnabledKey) === 'true'
  } catch {
    return false
  }
}
```

### 3. PostHog - Dynamic Persistence Mode
```typescript
// Before: Always used localStorage
persistence: 'localStorage'

// After: Detect availability and fall back to memory
const isLocalStorageAvailable = (() => {
  try {
    const test = '__storage_test__'
    localStorage.setItem(test, test)
    localStorage.removeItem(test)
    return true
  } catch {
    return false
  }
})()

persistence: isLocalStorageAvailable ? 'localStorage' : 'memory'
```

### 4. Auth Token Storage - Memory Fallback
```typescript
// Created safe storage abstraction with in-memory fallback
const memoryStorage = new Map<string, string>()

const safeGetItem = (key: string): string | null => {
  try {
    if (isLocalStorageAvailable()) {
      return localStorage.getItem(key)
    }
  } catch {
    // Fall through to memory storage
  }
  return memoryStorage.get(key) ?? null
}

// All auth functions now use safe storage
export const getAuthToken = (): string | null => safeGetItem(AUTH_TOKEN_KEY)
```

### 5. Credentials Reset - Silent Failure
```typescript
// Before: Unhandled localStorage.clear()
localStorage.clear()
window.location.reload()

// After: Try-catch, continue with reload
try {
  localStorage.clear()
} catch {
  // localStorage not available - continue with reload
}
window.location.reload()
```

## Impact

### Before
- ❌ Blank screen in production
- ❌ PostHog rate limiting errors
- ❌ App crash on localStorage access

### After
- ✅ App works in all security contexts
- ✅ Graceful degradation when storage unavailable
- ✅ PostHog uses memory persistence as fallback
- ✅ Auth tokens stored in memory if localStorage blocked
- ✅ Theme defaults to system preference

## Trade-offs

When localStorage is unavailable:
- **Theme preference** - Not persisted across sessions (reverts to system/default)
- **Sync preference** - Defaults to disabled
- **Auth tokens** - Session-only (lost on refresh) - user must re-authenticate
- **PostHog** - Uses memory persistence (analytics reset on page reload)

These trade-offs are acceptable because:
1. The app remains functional (no blank screen)
2. Security contexts blocking storage are typically temporary/test environments
3. Users can still complete their tasks
4. Better to lose preferences than have a broken app

## Testing

All existing tests pass:
```bash
✓ bun test src/lib/auth-token.test.ts
✓ bun run type-check
```

## Prevention

To prevent similar issues in the future:

1. **Never access localStorage directly** - always wrap in try-catch
2. **Test in restrictive contexts** - HTTP, iframes, incognito mode
3. **Provide fallbacks** - memory storage, default values, graceful degradation
4. **Monitor for DOMExceptions** - add error tracking for storage access failures

## Related Files

- `src/lib/theme-provider.tsx`
- `src/db/powersync/database.ts`
- `src/lib/posthog.tsx`
- `src/lib/auth-token.ts`
- `src/hooks/use-powersync-credentials-invalid-listener.ts`
