/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const maxLength = 64

/**
 * Convert an arbitrary title (e.g. an automation name like "Daily Brief")
 * into a slug that satisfies the AgentSkills spec:
 *
 * - Lowercase a–z, 0–9, hyphens only
 * - 1–64 chars
 * - No leading / trailing hyphens
 * - No consecutive hyphens
 *
 * Returns `null` when the input would produce an empty slug (e.g. only
 * punctuation or whitespace). Callers should skip migration for those rows
 * — there's no honest name to give the migrated skill.
 */
export const slugifySkillName = (title: string): string | null => {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '')
  return slug.length > 0 ? slug : null
}
