/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getClock } from '@/testing-library'
import { ContextUsageIndicator } from './context-usage-indicator'

afterEach(cleanup)

describe('ContextUsageIndicator', () => {
  it('disables compaction until a response supplies a checkpoint boundary', () => {
    const compact = mock(async () => {})
    render(<ContextUsageIndicator usedTokens={20} maxTokens={1_000} onCompact={compact} hasHistory={false} />)
    fireEvent.click(screen.getByRole('button', { name: 'Context usage' }))
    const button = screen.getByRole('button', { name: 'Compact now' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(compact).not.toHaveBeenCalled()
    fireEvent.focus(button.parentElement!)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Nothing to compact yet.')
  })

  it('opens an accessible context menu with a pointer cursor and compacts immediately', async () => {
    const compact = mock(async () => {})
    render(<ContextUsageIndicator usedTokens={800} maxTokens={1000} onCompact={compact} />)
    const trigger = screen.getByRole('button', { name: 'Context usage' })
    expect(trigger).toHaveClass('cursor-pointer')
    expect(trigger).toHaveTextContent('80%')
    fireEvent.focus(trigger)
    expect(screen.getByRole('tooltip')).toHaveTextContent('800 of 1K Context Window')
    fireEvent.click(trigger)
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(within(screen.getByRole('dialog')).queryByText(/context window/i)).toBeNull()
    expect(screen.getByLabelText('Compaction instructions (optional)')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'View summary' })).toBeNull()
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Compact now' })))
    expect(compact).toHaveBeenCalledWith(undefined)
    expect(screen.queryByRole('button', { name: 'Compact now' })).toBeNull()
  })

  it('passes custom instructions and disables duplicate actions during the request', async () => {
    const pending = Promise.withResolvers<void>()
    const compact = mock(() => pending.promise)
    render(<ContextUsageIndicator usedTokens={20} maxTokens={1000} onCompact={compact} />)
    fireEvent.click(screen.getByRole('button', { name: 'Context usage' }))
    fireEvent.change(screen.getByLabelText('Compaction instructions (optional)'), {
      target: { value: '  Keep decisions  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Compact now' }))
    expect(compact).toHaveBeenCalledWith('Keep decisions')
    expect(screen.getByRole('button', { name: 'Compacting context…' })).toBeDisabled()
    await act(async () => pending.resolve())
  })

  it('keeps instructions after failure and allows a retry', async () => {
    const errorLog = spyOn(console, 'error').mockImplementation(() => {})
    const compact = mock(async () => {
      throw new Error('offline')
    })
    render(<ContextUsageIndicator usedTokens={20} maxTokens={1000} onCompact={compact} />)
    fireEvent.click(screen.getByRole('button', { name: 'Context usage' }))
    fireEvent.change(screen.getByLabelText('Compaction instructions (optional)'), {
      target: { value: 'Keep decisions' },
    })
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Compact now' })))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not compact context')
    expect(screen.getByLabelText('Compaction instructions (optional)')).toHaveValue('Keep decisions')
    expect(screen.getByRole('button', { name: 'Compact now' })).toBeEnabled()
    expect(errorLog).toHaveBeenCalledWith('Context compaction failed', expect.any(Error))
    errorLog.mockRestore()
  })

  it('explains the disabled action on hover and keyboard focus without adding menu text', async () => {
    render(<ContextUsageIndicator usedTokens={20} maxTokens={1000} onCompact={async () => {}} busy />)
    fireEvent.click(screen.getByRole('button', { name: 'Context usage' }))
    const button = screen.getByRole('button', { name: 'Compact now' })
    expect(button).toBeDisabled()
    expect(screen.queryByText('Wait for the current response to finish before compacting.')).toBeNull()
    const target = button.parentElement!
    expect(target.tabIndex).toBe(0)
    fireEvent.pointerMove(target, { pointerType: 'mouse' })
    await act(async () => {
      await getClock().tickAsync(1)
    })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Wait for the current response to finish before compacting.')
    fireEvent.pointerLeave(target, { pointerType: 'mouse' })
    fireEvent.focus(target)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Wait for the current response to finish before compacting.')
  })

  it('explains unsupported agents and handles an unknown context window without NaN', () => {
    render(<ContextUsageIndicator usedTokens={0} maxTokens={0} />)
    const trigger = screen.getByRole('button', { name: 'Context usage' })
    expect(trigger).toHaveTextContent('0%')
    fireEvent.click(trigger)
    expect(screen.queryByRole('button', { name: 'Compact now' })).toBeNull()
    expect(screen.getByText('Context compaction is available with supported built-in models.')).toBeInTheDocument()
  })

  it('opens a saved summary while busy and closes the menu without starting compaction', () => {
    const compact = mock(async () => {})
    const view = mock()
    render(<ContextUsageIndicator usedTokens={800} maxTokens={1000} onCompact={compact} onViewSummary={view} busy />)
    const trigger = screen.getByRole('button', { name: 'Context usage' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: 'View summary' }))
    expect(view).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(compact).not.toHaveBeenCalled()
  })
})
