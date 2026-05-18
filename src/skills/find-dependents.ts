/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Skill } from './skills-data'

/**
 * Finds skills whose description or instruction references the target skill's
 * name as a slash-token (followed by whitespace or end-of-line). Matches the
 * same rule as the highlight overlay so what the user *sees* as a reference
 * is what we *count* as a dependency.
 */
export const findDependents = (targetName: string, library: Skill[]): Skill[] => {
  const escaped = targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`${escaped}(?=\\s|$)`)
  return library.filter((s) => s.name !== targetName && (pattern.test(s.description) || pattern.test(s.instruction)))
}
