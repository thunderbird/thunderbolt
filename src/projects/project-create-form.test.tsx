/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it, mock, spyOn } from 'bun:test'
import { useRef } from 'react'
import { useProjectCreateState, type ProjectCreateValues } from './use-project-create-state'
import { ProjectCreateForm } from './project-create-form'

const Fixture = ({ onSubmit }: { onSubmit: (values: ProjectCreateValues) => Promise<void> }) => {
  const form = useProjectCreateState(onSubmit)
  const inputRef = useRef<HTMLInputElement>(null)
  return <ProjectCreateForm form={form} inputRef={inputRef} onCancel={() => {}} />
}

it('creates from only a name and emoji, and never submits when opening the icon picker', async () => {
  const onSubmit = mock(async () => {})
  render(<Fixture onSubmit={onSubmit} />)
  const name = screen.getByRole('textbox', { name: 'Name' })
  expect(name).toHaveFocus()
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  fireEvent.change(name, { target: { value: '   ' } })
  fireEvent.submit(name.closest('form')!)
  expect(onSubmit).not.toHaveBeenCalled()
  fireEvent.change(name, { target: { value: '  Research  ' } })
  const picker = screen.getByRole('button', { name: /Choose an icon/ })
  expect(picker).toHaveAttribute('type', 'button')
  fireEvent.click(picker)
  const emoji = screen.getByRole('button', { name: '📁' })
  fireEvent.click(emoji)
  expect(onSubmit).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.submit(name.closest('form')!)
  })
  expect(onSubmit).toHaveBeenCalledWith({ name: 'Research', icon: '📁' })
})

it('keeps the draft on failure and allows retrying without duplicate pending submissions', async () => {
  const pending = Promise.withResolvers<void>()
  const onSubmit = mock(() => pending.promise)
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    render(<Fixture onSubmit={onSubmit} />)
    const name = screen.getByRole('textbox', { name: 'Name' })
    fireEvent.change(name, { target: { value: 'Research' } })
    await act(async () => {
      fireEvent.submit(name.closest('form')!)
    })
    expect(name).toBeDisabled()
    fireEvent.submit(name.closest('form')!)
    expect(onSubmit).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.reject(new Error('Offline'))
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Could not create the project.')
    expect(name).toHaveValue('Research')
    expect(name).not.toBeDisabled()
    onSubmit.mockImplementation(async () => {})
    await act(async () => {
      fireEvent.submit(name.closest('form')!)
    })
    expect(onSubmit).toHaveBeenCalledTimes(2)
  } finally {
    log.mockRestore()
  }
})
