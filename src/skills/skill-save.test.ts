/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock, spyOn } from 'bun:test'
import { SkillNameInvalidError, SkillNameTakenError } from '@/dal'
import { handleSkillSaveError, skillCreateInitialValues } from './skill-save'

describe('handleSkillSaveError', () => {
  it('routes SkillNameTakenError to onSlugRejected with its message', () => {
    const onSlugRejected = mock((_message: string) => {})
    const onFailed = mock(() => {})

    handleSkillSaveError(new SkillNameTakenError('meeting-notes'), { onSlugRejected, onFailed })

    expect(onSlugRejected).toHaveBeenCalledWith('A skill named "meeting-notes" already exists.')
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('routes SkillNameInvalidError to onSlugRejected with its message', () => {
    const onSlugRejected = mock((_message: string) => {})
    const onFailed = mock(() => {})

    handleSkillSaveError(new SkillNameInvalidError('Use lowercase letters only.'), { onSlugRejected, onFailed })

    expect(onSlugRejected).toHaveBeenCalledWith('Use lowercase letters only.')
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('logs a generic error and reports it via onFailed', () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const onSlugRejected = mock((_message: string) => {})
    const onFailed = mock(() => {})
    const error = new Error('disk full')

    try {
      handleSkillSaveError(error, { onSlugRejected, onFailed })

      expect(onSlugRejected).not.toHaveBeenCalled()
      expect(onFailed).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalledWith('Failed to save skill', error)
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('skillCreateInitialValues', () => {
  it('returns undefined for a missing name', () => {
    expect(skillCreateInitialValues(undefined)).toBeUndefined()
    expect(skillCreateInitialValues(null)).toBeUndefined()
  })

  it('returns undefined for an empty string', () => {
    expect(skillCreateInitialValues('')).toBeUndefined()
  })

  it('pre-fills the slug with a Title Case name suggestion', () => {
    expect(skillCreateInitialValues('daily-brief')).toEqual({
      name: 'daily-brief',
      label: 'Daily Brief',
      description: '',
      instruction: '',
    })
  })
})
