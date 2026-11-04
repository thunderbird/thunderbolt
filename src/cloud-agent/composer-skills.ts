/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { CloudSkill } from '@shared/cloud-agent/contracts'
import type { Skill } from '@/types'

/** Match saved cloud skills to the live library while preserving the instructions the runtime actually received. */
export const cloudComposerSkills = (
  library: Skill[],
  configured: CloudSkill[],
  isEnabled: (id: string) => boolean,
): Skill[] =>
  configured.flatMap((saved) => {
    const source = library.find((skill) => (saved.sourceId ? skill.id === saved.sourceId : skill.name === saved.name))
    return source && !source.deletedAt && isEnabled(source.id)
      ? [{ ...source, name: saved.name, description: saved.description, instruction: saved.instruction }]
      : []
  })

/** Reorder a filtered skill bar without dropping or moving pins hidden in this execution environment. */
export const mergeVisibleSkillPinOrder = (allIds: string[], visibleIds: string[]): string[] => {
  const visible = new Set(visibleIds)
  const positions = new Map(allIds.filter((id) => visible.has(id)).map((id, index) => [id, index]))
  return allIds.map((id) => {
    const position = positions.get(id)
    return position === undefined ? id : visibleIds[position]
  })
}
