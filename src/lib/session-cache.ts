/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Cache of the last successful Better Auth session response in localStorage.
 *
 * Used to seed `authClient.$store.atoms.session` on app start so the auth gate
 * doesn't redirect to the login screen when offline (THU-580). Better Auth's
 * `useSession` requires a network round-trip on mount; without a seed, the
 * offline fetch fails and `data` stays null, which the gate treats as logged-out.
 *
 * Lifecycle:
 *  - written from `AuthProvider` whenever the session atom receives non-null data
 *  - cleared on 401 (token rejection) and on logout/wipe (via `clearLocalData`)
 *
 * Stored in localStorage to match the existing pattern in `auth-token.ts`.
 */

const sessionCacheKey = 'thunderbolt_session_cache'

export type CachedSessionData = Record<string, unknown>

/** Read the cached session, or null when absent / malformed. */
export const getCachedSession = (): CachedSessionData | null => {
  try {
    const raw = localStorage.getItem(sessionCacheKey)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return parsed as CachedSessionData
    }
    return null
  } catch {
    return null
  }
}

/** Persist the latest session payload. Silently no-ops if localStorage rejects the write. */
export const setCachedSession = (data: CachedSessionData): void => {
  try {
    localStorage.setItem(sessionCacheKey, JSON.stringify(data))
  } catch {
    // Quota exceeded or storage unavailable — caching is best-effort.
  }
}

/** Remove any cached session (used on logout, 401, and full wipe). */
export const clearCachedSession = (): void => {
  localStorage.removeItem(sessionCacheKey)
}
