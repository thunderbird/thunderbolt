/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Skill } from '@/types'

/**
 * Suggest a Title Case display name from a slug ("daily-brief" → "Daily
 * Brief"). Used as the display fallback for rows without a label, to prefill
 * the Name field when editing such a row, and when creating from a slug typed
 * in chat.
 */
export const titleCaseFromSlug = (slug: string): string =>
  slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')

/**
 * Human display name for a skill. Rows created before the label column
 * existed (or synced from an older client) have `label` null — reconcile
 * can't backfill them (adding `label` to `hashSkill` makes legacy rows read
 * as user-edited), so title-case the slug instead of rendering it raw.
 */
export const skillDisplayName = (skill: Pick<Skill, 'name' | 'label'>): string => {
  const label = skill.label?.trim()
  return label ? label : titleCaseFromSlug(skill.name)
}

/**
 * Map from display name → slug for resolving composer `/Display Name` tokens
 * back to their canonical slug at send time. Display names are not unique
 * (labels are free text), so ambiguous names — two skills sharing one display
 * name — are omitted entirely: an unresolvable token degrading to plain text
 * beats silently sending the wrong skill's instructions.
 */
export const buildDisplayNameToSlug = (skills: ReadonlyArray<Pick<Skill, 'name' | 'label'>>): Map<string, string> => {
  const bySlug = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const skill of skills) {
    const displayName = skillDisplayName(skill)
    if (bySlug.has(displayName)) {
      ambiguous.add(displayName)
      continue
    }
    bySlug.set(displayName, skill.name)
  }
  for (const displayName of ambiguous) {
    bySlug.delete(displayName)
  }
  return bySlug
}
