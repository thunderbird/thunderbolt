/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCallback, useContext } from 'react'

import { AuthContext } from '@/contexts/auth-context'
import { trackEvent } from '@/lib/posthog'

/**
 * Skills v1 §6 telemetry.
 *
 * Every skill_* event carries a hashed `skill_id` (and never any of the
 * user's authored content). The hash is `sha256(user_id + ':' + skill.id)`,
 * truncated to 16 hex chars — enough to make collisions astronomically
 * unlikely at PostHog's scale while making the id unlinkable across users.
 *
 * Skill UUIDs are already opaque, but combining with `user_id` means
 * PostHog (or anyone reading the analytics pipeline) can't correlate the
 * same skill across multiple users — useful when (eventually) skills are
 * shareable or installable.
 */

const sha256Hex = async (text: string): Promise<string> => {
  const buf = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Compute the truncated SHA-256 hash for a (user_id, skill.id) pair. */
export const hashSkillId = async (userId: string, skillId: string): Promise<string> => {
  const full = await sha256Hex(`${userId}:${skillId}`)
  return full.slice(0, 16)
}

/** Event-shape map. Lets the tracker type-check the props per event. */
export type SkillEventProps = {
  skill_used: { via: 'slash' | 'chip' | 'settings-nav' }
  skill_created: { instruction_length: number }
  skill_edited: { renamed: boolean }
  skill_deleted: Record<string, never>
  skill_pinned: Record<string, never>
  skill_unpinned: Record<string, never>
  skill_reordered: { from_index: number; to_index: number }
}

export type SkillEventName = keyof SkillEventProps

/**
 * Hook that returns a fire-and-forget telemetry tracker for skill_* events.
 * The user-id half of the hash is captured from the current session once
 * per hook call; the hash itself is computed per-event (async) and the
 * track call is dispatched once it resolves.
 *
 * Anonymous users get a stable `anonymous` salt — same user across a
 * session still produces the same hash for the same skill, but the salt
 * doesn't tie back to any real account.
 */
/**
 * Stub used when `useSkillTelemetry` mounts outside an `AuthProvider`
 * (tests / Storybook). The hook call must be unconditional to satisfy
 * Rules of Hooks — we swap in a stub that returns a synchronous empty
 * session rather than branching around the real `authClient.useSession()`.
 *
 * Telemetry no-ops in this state anyway: there's no `AuthContext`, so the
 * tracker returns early without firing PostHog.
 */
const stubAuthClient = { useSession: () => ({ data: undefined }) }

export const useSkillTelemetry = () => {
  // Read `AuthContext` directly instead of `useAuth()` because tests +
  // Storybook may mount the composer without an `AuthProvider`. The hook
  // returns a no-op tracker in that case — analytics is a side effect, not
  // a critical path, and a thrown hook would surface as a render error.
  const ctx = useContext(AuthContext)
  const enabled = ctx !== undefined
  // Hook call must be unconditional; the stub keeps the call shape stable
  // when AuthContext is absent.
  const authClient = ctx?.authClient ?? stubAuthClient
  const { data: session } = authClient.useSession()
  const userId = session?.user?.id ?? 'anonymous'

  return useCallback(
    <E extends SkillEventName>(event: E, skillId: string, extras: SkillEventProps[E]) => {
      if (!enabled) {
        return
      }
      hashSkillId(userId, skillId)
        .then((hashedId) => {
          // PostHog's `trackEvent` accepts a generic `Record<string, unknown>`;
          // our per-event prop shape is the stricter type-checked contract for
          // *callers* of `useSkillTelemetry`. The widening cast is just to
          // satisfy that boundary.
          trackEvent(event, { skill_id: hashedId, ...extras } as Record<string, unknown>)
        })
        .catch((err) => {
          // `crypto.subtle.digest` can reject in insecure contexts (e.g. when
          // `crypto.subtle` is unavailable). Telemetry is fire-and-forget — we
          // swallow the rejection so it doesn't surface as an unhandled
          // promise rejection in browsers or crash Node-based test runners.
          console.warn('[skills] telemetry hash failed', err)
        })
    },
    [enabled, userId],
  )
}
