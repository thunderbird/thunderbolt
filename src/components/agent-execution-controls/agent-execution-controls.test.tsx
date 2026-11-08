/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentExecutionControls } from './agent-execution-controls'
import { getAgentExecution, useAgentExecutionStore } from '@/agent-execution/store'

afterEach(() => {
  cleanup()
  useAgentExecutionStore.setState({ byThread: {} })
})

describe('execution controls', () => {
  it('offers sandbox and future cloud on web without exposing computer access', () => {
    render(<AgentExecutionControls threadId="controls-test" disabled={false} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent location' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    expect(screen.queryByText('This computer')).toBeNull()
    expect(screen.getByText('Cloud').closest('[role="menuitem"]')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('shows full access in red and scopes a changed setting to the current chat', () => {
    render(<AgentExecutionControls threadId="controls-test" disabled={false} />)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent access' }), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    })
    const full = screen.getByText('Full access').closest('[role="menuitem"]')!
    expect(full.getAttribute('data-variant')).toBe('destructive')
    fireEvent.click(full)
    expect(getAgentExecution('controls-test').access).toBe('full')
    expect(getAgentExecution('other').access).toBe('ask')
    expect(screen.getByRole('button', { name: 'Agent access' }).className).toContain('text-destructive')
  })

  it('locks runtime and access changes during a running turn', () => {
    render(<AgentExecutionControls threadId="controls-test" disabled />)
    expect(screen.getByRole('button', { name: 'Agent location' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Agent access' }).hasAttribute('disabled')).toBe(true)
  })
})
