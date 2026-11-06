/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { SkillForm } from './skill-form'

const noop = () => {}

const editValues = {
  name: 'daily-brief',
  label: 'Daily Brief',
  description: 'desc',
  instruction: 'do stuff',
}

afterEach(() => {
  cleanup()
})

describe('SkillForm slug auto-generation', () => {
  it('create mode: typing a Name generates the slug until the slug is edited', () => {
    render(<SkillForm onCancel={noop} onSubmit={noop} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Meeting Notes' } })
    expect(screen.getByLabelText('Slug')).toHaveValue('meeting-notes')

    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'custom-slug' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed' } })
    expect(screen.getByLabelText('Slug')).toHaveValue('custom-slug')
  })

  it('create mode: clearing the slug hands control back to auto-generation', () => {
    render(<SkillForm onCancel={noop} onSubmit={noop} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Meeting Notes' } })
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: 'custom-slug' } })
    fireEvent.change(screen.getByLabelText('Slug'), { target: { value: '' } })

    // Clearing re-attaches: the slug regenerates from the current Name…
    expect(screen.getByLabelText('Slug')).toHaveValue('meeting-notes')
    // …and keeps following it.
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Weekly Review' } })
    expect(screen.getByLabelText('Slug')).toHaveValue('weekly-review')
  })

  it('edit mode: never auto-rewrites the slug, even after clearing it', () => {
    render(<SkillForm mode="edit" initialValues={editValues} onCancel={noop} onSubmit={noop} />)

    // Renaming must not touch the existing slug (it would break `/tokens`).
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rebranded Brief' } })
    const slugInput = screen.getByLabelText('Slug')
    expect(slugInput).toHaveValue('daily-brief')

    // Clearing the slug must NOT re-attach auto-generation in edit mode —
    // the user is retyping it deliberately, not asking for a rename cascade.
    fireEvent.change(slugInput, { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Another Name' } })
    expect(slugInput).toHaveValue('')
  })
})

describe('SkillForm responsive layout', () => {
  it('keeps the Instructions field usable before the mobile modal scrolls', () => {
    render(<SkillForm onCancel={noop} onSubmit={noop} />)

    expect(screen.getByLabelText('Instructions')).toHaveClass('min-h-48', 'md:min-h-0')
  })
})

describe('SkillForm edit submission', () => {
  it('enables Save only while the form differs from its initial values', () => {
    render(<SkillForm mode="edit" initialValues={editValues} onCancel={noop} onSubmit={noop} />)

    const saveButton = screen.getByRole('button', { name: 'Save' })
    expect(saveButton).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Updated Brief' } })
    expect(saveButton).toBeEnabled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: editValues.label } })
    expect(saveButton).toBeDisabled()
  })
})

describe('SkillForm slug input', () => {
  it('uses the standard input in edit mode', () => {
    render(<SkillForm mode="edit" initialValues={editValues} onCancel={noop} onSubmit={noop} />)

    expect(screen.getByRole('textbox', { name: 'Slug' })).toHaveValue('daily-brief')
    expect(screen.queryByRole('button', { name: 'Edit slug' })).not.toBeInTheDocument()
  })
})
