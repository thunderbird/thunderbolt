/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { importWhenReachable } from '@/lib/import-when-reachable'
import type { officeSkillNames } from '../constants'

export type OfficeSkillFormat = keyof typeof officeSkillNames

/**
 * Characters in each manual, so the composer can size a `/office-…` token without loading the text.
 * `src/defaults/skills.test.ts` keeps them equal to the manuals.
 */
export const officeSkillLengths = { docx: 7799, xlsx: 11998, pptx: 9818 } satisfies Record<OfficeSkillFormat, number>

// Each import starts only once the app's server answers: Safari never retries a module that failed to load.
const loaders = {
  docx: importWhenReachable(async () => (await import('./docx')).officeDocxSkill),
  xlsx: importWhenReachable(async () => (await import('./xlsx')).officeXlsxSkill),
  pptx: importWhenReachable(async () => (await import('./pptx')).officePptxSkill),
} satisfies Record<OfficeSkillFormat, () => Promise<string>>

/**
 * The manual for one Office format, from its own chunk so it stays out of the entry bundle. The promise is cached, so
 * React's `use()` can read it across renders. A failed load is forgotten, so the next use retries.
 */
export const loadOfficeSkillBody = (format: OfficeSkillFormat): Promise<string> => loaders[format]()
