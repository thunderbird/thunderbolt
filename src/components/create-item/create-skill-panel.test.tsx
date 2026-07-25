/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { useLibrarySkills } from '@/skills/use-skills'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from 'bun:test'
import { CreateSkillPanel } from './create-skill-panel'

const SkillOptionsProbe = () => {
  const { skills } = useLibrarySkills()
  return <div data-testid="skill-options">{skills.map((skill) => skill.label).join('|')}</div>
}

describe('CreateSkillPanel', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    cleanup()
    await resetTestDatabase()
  })

  it('refreshes skill options before closing after creation', async () => {
    const onClose = mock(() => {})

    render(
      <>
        <CreateSkillPanel open onClose={onClose} />
        <SkillOptionsProbe />
      </>,
      { wrapper: createTestProvider() },
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'New Chat Skill' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), {
      target: { value: 'Use for a new chat' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), {
      target: { value: 'Help with the new chat' },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      await getClock().runAllAsync()
    })

    expect(screen.getByTestId('skill-options')).toHaveTextContent('New Chat Skill')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
