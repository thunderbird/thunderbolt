/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Session } from '@/contexts/auth-context'

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
 * Stored in localStorage to match the existing pattern in `auth-token.ts`. Note
 * that this widens the localStorage exfil surface from the bare bearer token to
 * the full user profile (id, email, name, `isAnonymous`) — same exposure class
 * as the token itself, but more identifying if an attacker gets read access.
 */

const sessionCacheKey = 'thunderbolt_session_cache'

/**
 * Shape of the payload as it exists in localStorage — a JSON-serialized subset
 * of Better Auth's `Session`. `Date` fields (e.g. `session.expiresAt`) round-
 * trip to ISO strings through `JSON.stringify`, so `expiresAt` is widened to
 * `string | number | Date`. Everything else is `Partial` because the localStorage
 * value predates our writer contract (older shapes, corruption, manual edits) —
 * reads are validated at runtime by {@link isCachedSessionValid}.
 */
export type CachedSessionData = {
  user?: Partial<Session['user']>
  session?: Partial<Omit<Session['session'], 'expiresAt'>> & { expiresAt?: string | number | Date }
}

/** Read the cached session, or null when absent / malformed. */
export const getCachedSession = (): CachedSessionData | null => {
  try {
    const raw = localStorage.getItem(sessionCacheKey)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
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

/**
 * True when the cached payload has a `session.expiresAt` in the future.
 *
 * Called before seeding the atom so an offline device past the token's TTL
 * doesn't boot as logged in (THU-580 review). A cache without a parseable
 * `expiresAt` is treated as invalid — likely an older payload shape, and a
 * fresh `/get-session` is safer than trusting it.
 */
export const isCachedSessionValid = (cached: CachedSessionData): boolean => {
  if (!cached.session?.expiresAt) {
    return false
  }
  const expiresAt = new Date(cached.session.expiresAt).getTime()
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}
