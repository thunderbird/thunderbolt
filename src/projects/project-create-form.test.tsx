/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
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
  expect(screen.getByRole('button', { name: 'Project environment' })).toHaveTextContent('Local sandbox')
  expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
  fireEvent.change(name, { target: { value: '   ' } })
  fireEvent.submit(name.closest('form')!)
  expect(onSubmit).not.toHaveBeenCalled()
  fireEvent.change(name, { target: { value: '  Research  ' } })
  const picker = screen.getByRole('button', { name: /Choose an icon/ })
  fireEvent.click(picker)
  const emoji = screen.getByRole('button', { name: '📁' })
  fireEvent.click(emoji)
  expect(onSubmit).not.toHaveBeenCalled()
  await act(async () => {
    fireEvent.submit(name.closest('form')!)
  })
  expect(onSubmit).toHaveBeenCalledWith({
    name: 'Research',
    icon: '📁',
    execution: { location: 'sandbox', access: 'ask' },
  })
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

it('includes the explicitly selected permission when creating a project', async () => {
  const onSubmit = mock(async () => {})
  render(<Fixture onSubmit={onSubmit} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Trusted project' } })
  expect(screen.getByLabelText('Agent permissions')).toHaveTextContent('Ask for approval')
  fireEvent.pointerDown(screen.getByLabelText('Agent permissions'), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(screen.getByRole('menuitem', { name: /Full access/ }))
  expect(screen.getByLabelText('Agent permissions')).toHaveTextContent('Full access')
  expect(onSubmit).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Create' })))
  expect(onSubmit).toHaveBeenCalledWith({
    name: 'Trusted project',
    icon: null,
    execution: { location: 'sandbox', access: 'full' },
  })
})

it('reserves creation synchronously before the transition renders', async () => {
  const pending = Promise.withResolvers<void>()
  const onSubmit = mock(() => pending.promise)
  const { result } = renderHook(() => useProjectCreateState(onSubmit))
  act(() => result.current.setName('Research'))
  act(() => {
    result.current.submit()
    result.current.submit()
  })
  expect(onSubmit).toHaveBeenCalledTimes(1)
  await act(async () => {
    pending.resolve()
    await pending.promise
  })
})

it('does not navigate to a project created after its dialog was dismissed', async () => {
  const pending = Promise.withResolvers<string>()
  const onCreated = mock(() => {})
  const { result, unmount } = renderHook(() => useProjectCreateState(() => pending.promise, onCreated))
  act(() => result.current.setName('Research'))
  act(() => result.current.submit())
  unmount()
  await act(async () => {
    pending.resolve('project-id')
    await pending.promise
  })
  expect(onCreated).not.toHaveBeenCalled()
})
