/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { ProjectForm, type ProjectFormValues } from './project-form'

afterEach(cleanup)

const values: ProjectFormValues = {
  icon: '📊',
  name: 'Q3 Planning',
  description: 'Quarterly work',
  instructions: 'Reply in bullet points.',
}

const renderForm = (onSubmit = mock(async (_values: ProjectFormValues) => {})) => {
  const onCancel = mock(() => {})
  render(<ProjectForm initialValues={values} onCancel={onCancel} onSubmit={onSubmit} />)
  return { onSubmit, onCancel }
}

describe('ProjectForm in edit mode', () => {
  it('starts from the project’s current values', () => {
    renderForm()
    expect(screen.getByLabelText('Name')).toHaveValue('Q3 Planning')
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('Quarterly work')
    expect(screen.getByLabelText('Instructions')).toHaveValue('Reply in bullet points.')
  })

  it('submits the edited values', async () => {
    const { onSubmit } = renderForm()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Q4 Planning' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    // Flush the submit's microtasks rather than polling: this project's
    // testing-library config disables fake-timer waiting, so `waitFor` throws.
    await act(async () => {})
    expect(onSubmit).toHaveBeenCalled()
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'Q4 Planning', icon: '📊' })
  })

  it('labels its action Save changes, not Create', () => {
    renderForm()
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
  })

  it('refuses to save a project with no name', () => {
    renderForm()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
  })

  it('shows a failed save instead of dropping it', async () => {
    // React does not await this handler, so an uncaught rejection would leave the
    // user believing the edit was saved.
    const failing = mock(async () => {
      throw new Error('Project name is required.')
    })
    renderForm(failing)
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await act(async () => {})
    expect(screen.getByRole('alert')).toHaveTextContent('Project name is required.')
  })

  it('cancels without submitting', () => {
    const { onSubmit, onCancel } = renderForm()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
