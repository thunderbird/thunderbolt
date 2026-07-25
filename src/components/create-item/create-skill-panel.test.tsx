/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as dal from '@/dal'
import { createSkill } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { skillSaveFailedMessage } from '@/skills/skill-save'
import { useLibrarySkills } from '@/skills/use-skills'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { CreateSkillPanel } from './create-skill-panel'

const SkillOptionsProbe = () => {
  const { skills } = useLibrarySkills()
  return <div data-testid="skill-options">{skills.map((skill) => skill.label).join('|')}</div>
}

const noopCloseComplete = () => {}

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
        <CreateSkillPanel open onClose={onClose} onCloseComplete={noopCloseComplete} />
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

  it('surfaces a duplicate-name error inline and keeps the panel open', async () => {
    await createSkill(getDb(), { name: 'meeting-notes', label: 'Meeting Notes', description: 'd', instruction: 'i' })
    const onClose = mock(() => {})

    render(<CreateSkillPanel open onClose={onClose} onCloseComplete={noopCloseComplete} />, {
      wrapper: createTestProvider(),
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Meeting Notes' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'dup' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), { target: { value: 'dup' } })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      await getClock().runAllAsync()
    })

    expect(screen.getByText('A skill named "meeting-notes" already exists.')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows the generic save-failed message and keeps the panel open when creation fails unexpectedly', async () => {
    // handleSkillSaveError logs the unexpected failure; muted to keep test output clean.
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const createSkillSpy = spyOn(dal, 'createSkill').mockRejectedValue(new Error('disk full'))
    const onClose = mock(() => {})

    try {
      render(<CreateSkillPanel open onClose={onClose} onCloseComplete={noopCloseComplete} />, {
        wrapper: createTestProvider(),
      })

      fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Doomed Skill' } })
      fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'd' } })
      fireEvent.change(screen.getByRole('textbox', { name: 'Instructions' }), { target: { value: 'i' } })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Create' }))
        await getClock().runAllAsync()
      })

      expect(screen.getByText(skillSaveFailedMessage)).toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      createSkillSpy.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('guards a dirty close behind the discard dialog', async () => {
    const onClose = mock(() => {})

    render(<CreateSkillPanel open onClose={onClose} onCloseComplete={noopCloseComplete} />, {
      wrapper: createTestProvider(),
    })

    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Half-typed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    // The dirty form is not closed — the discard prompt intervenes.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Leave without creating?')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
      await getClock().runAllAsync()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('pre-fills the form from an unknown token slug', () => {
    render(<CreateSkillPanel open onClose={() => {}} onCloseComplete={noopCloseComplete} initialName="daily-brief" />, {
      wrapper: createTestProvider(),
    })

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Daily Brief')
  })
})
