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
 * Case-insensitive skill search shared by the slash popup, the pin popover,
 * and the settings list: a skill matches when the query appears anywhere in
 * its slug (`name`) or its display name ({@link skillDisplayName}, so
 * label-less legacy rows are findable by their title-cased name too). An
 * empty query matches every skill.
 */
export const skillMatchesQuery = (skill: Pick<Skill, 'name' | 'label'>, query: string): boolean => {
  const lowered = query.toLowerCase()
  return skill.name.toLowerCase().includes(lowered) || skillDisplayName(skill).toLowerCase().includes(lowered)
}

/**
 * Map from display name → slug for resolving composer `/Display Name` tokens
 * back to their canonical slug at send time. Display names are not unique
 * (labels are free text), so ambiguous names — two skills sharing one display
 * name — are omitted entirely: an unresolvable token degrading to plain text
 * beats silently sending the wrong skill's instructions.
 */
export const buildDisplayNameToSlug = (skills: ReadonlyArray<Pick<Skill, 'name' | 'label'>>): Map<string, string> => {
  const slugByDisplayName = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const skill of skills) {
    const displayName = skillDisplayName(skill)
    if (slugByDisplayName.has(displayName)) {
      ambiguous.add(displayName)
      continue
    }
    slugByDisplayName.set(displayName, skill.name)
  }
  for (const displayName of ambiguous) {
    slugByDisplayName.delete(displayName)
  }
  return slugByDisplayName
}

/**
 * The composer token to insert for a skill: its display name when that name
 * unambiguously maps back to a single skill (i.e. it's present in
 * `displayNameToSlug`), else the raw slug. Ambiguous display names are
 * omitted from the map ({@link buildDisplayNameToSlug}), so falling back to
 * the slug prevents inserting a token that send-time normalization would
 * resolve to the wrong skill.
 */
export const tokenForSkill = (
  skill: Pick<Skill, 'name' | 'label'>,
  displayNameToSlug: ReadonlyMap<string, string>,
): string => {
  const displayName = skillDisplayName(skill)
  return displayNameToSlug.has(displayName) ? displayName : skill.name
}
