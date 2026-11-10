/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { trackEvent } from '@/lib/posthog'

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

/** Record skill interactions without account IDs, skill IDs, or authored content. */
export const trackSkillEvent = <E extends keyof SkillEventProps>(event: E, extras: SkillEventProps[E]) => {
  trackEvent(event, extras)
}
