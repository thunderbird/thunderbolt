/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SkillNameInvalidError, SkillNameTakenError } from '@/dal'
import { titleCaseFromSlug } from './display'
import { useSkillTelemetry } from './telemetry'
import { useLibrarySkills } from './use-skills'
import type { SkillFormValues } from './use-skill-form-state'

/** User-facing copy for an unexpected skill save failure — shared by the
 *  settings view and the quick-create panel so the two can't drift. */
export const skillSaveFailedMessage = "Couldn't save the skill. Please try again."

type SkillSaveErrorHandlers = {
  onSlugRejected: (message: string) => void
  onFailed: () => void
}

/**
 * Maps a failed skill save to its two user-facing outcomes: known slug errors
 * (name taken/invalid) surface next to the name field, everything else is
 * logged and reported as a generic submit failure.
 */
export const handleSkillSaveError = (error: unknown, { onSlugRejected, onFailed }: SkillSaveErrorHandlers): void => {
  if (error instanceof SkillNameTakenError || error instanceof SkillNameInvalidError) {
    onSlugRejected(error.message)
    return
  }
  console.error('Failed to save skill', error)
  onFailed()
}

/**
 * Creates a skill and records its creation telemetry — the one create path
 * shared by the settings view and the quick-create panel.
 */
export const useCreateSkillTracked = () => {
  const { createSkill } = useLibrarySkills()
  const trackSkillEvent = useSkillTelemetry()
  return async (values: SkillFormValues) => {
    const created = await createSkill(values)
    trackSkillEvent('skill_created', created.id, { instruction_length: values.instruction.length })
    return created
  }
}

/**
 * Pre-filled create-form values for a slug typed elsewhere (e.g. an unknown
 * skill token in chat), with a Title Case name suggestion.
 */
export const skillCreateInitialValues = (initialName: string | null | undefined): SkillFormValues | undefined =>
  initialName
    ? {
        name: initialName,
        label: titleCaseFromSlug(initialName),
        description: '',
        instruction: '',
      }
    : undefined
