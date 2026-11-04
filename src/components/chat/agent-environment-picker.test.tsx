/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, mock } from 'bun:test'
import { AgentEnvironmentPicker } from './agent-environment-picker'

afterEach(cleanup)

it('chooses a local runtime before the first message', () => {
  const onChange = mock(() => {})
  render(<AgentEnvironmentPicker value="cloud" locked={false} disabled={false} onChange={onChange} />)
  const trigger = screen.getByRole('button', { name: 'Execution environment' })
  expect(trigger).toHaveAttribute('title', 'Cloud')
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false })
  expect(screen.getByRole('menuitemradio', { name: 'Cloud' })).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByRole('menuitemradio', { name: 'This device' })).toHaveAttribute('aria-checked', 'false')
  expect(screen.getByRole('menuitemradio', { name: 'Cloud' }).querySelector('.lucide-circle')).toBeNull()
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'This device' }))
  expect(onChange).toHaveBeenCalledWith('local')
})

it('keeps an existing chat in its original runtime', () => {
  render(
    <AgentEnvironmentPicker
      value="local"
      locked
      disabled={false}
      onChange={() => {
        throw new Error('Must stay pinned')
      }}
    />,
  )
  const trigger = screen.getByRole('button', { name: 'Execution environment' })
  expect(trigger).toBeDisabled()
  expect(trigger).toHaveAttribute('title', 'This device')
  expect(trigger).toHaveAttribute('aria-description', 'Start a new chat to choose another environment.')
})
