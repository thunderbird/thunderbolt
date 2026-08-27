/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PendingToolApproval } from './mini-app-store'
import { ToolApprovalBar } from './tool-approval-bar'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

afterEach(cleanup)

const modelFacingDescription =
  'Change the status of one order. Valid statuses: open, shipped, cancelled. Use this when the user asks to ship, cancel or reopen an order.'

const pending = (overrides: Partial<PendingToolApproval['tool']> = {}, args: unknown = {}): PendingToolApproval =>
  ({
    tool: {
      name: 'set_order_status',
      description: modelFacingDescription,
      annotations: { readOnlyHint: false, title: 'Change an order status' },
      ...overrides,
    },
    args,
  }) as PendingToolApproval

const renderBar = (approval: PendingToolApproval) =>
  render(<ToolApprovalBar pending={approval} appName="Order Book" onDecide={() => {}} />)

describe('ToolApprovalBar', () => {
  it('leads with the author-written title, not the tool identifier', () => {
    renderBar(pending())
    expect(screen.getByText('Change an order status')).toBeTruthy()
  })

  it('falls back to the tool name when no title was declared', () => {
    const { container } = renderBar(pending({ annotations: { readOnlyHint: false } }))
    expect(container.querySelector('p')?.textContent).toBe('set_order_status')
  })

  it('does not repeat the identifier in the details when it is already the heading', () => {
    const { container } = renderBar(pending({ annotations: { readOnlyHint: false } }))
    expect(container.querySelectorAll('.font-mono')).toHaveLength(0)
  })

  /**
   * `description` is written for the model — long, and full of instructions
   * about when to call the tool. Someone deciding whether to allow it should not
   * have to read past that, so it lives behind the disclosure.
   */
  it('keeps the model-facing description out of the summary', () => {
    const { container } = renderBar(pending())
    const summary = container.querySelector('summary')

    expect(summary?.textContent).not.toContain(modelFacingDescription)
    expect(summary?.textContent).toContain('Order Book')
  })

  it('renders arguments as readable pairs rather than JSON', () => {
    renderBar(pending({}, { id: 'A-1041', status: 'shipped' }))

    expect(screen.getByText('id')).toBeTruthy()
    expect(screen.getByText('A-1041')).toBeTruthy()
    expect(screen.getByText('status')).toBeTruthy()
    expect(screen.getByText('shipped')).toBeTruthy()
  })

  it('still exposes the raw arguments underneath, for when the pairs are not enough', () => {
    const { container } = renderBar(pending({}, { id: 'A-1041' }))
    expect(container.querySelector('pre')?.textContent).toContain('"id": "A-1041"')
  })

  it('shows no argument list for a tool that takes none', () => {
    const { container } = renderBar(pending({}, {}))
    expect(container.querySelector('ul')).toBeNull()
  })

  it('renders a nested value as JSON rather than [object Object]', () => {
    renderBar(pending({}, { filter: { status: 'open' } }))
    expect(screen.getByText('{"status":"open"}')).toBeTruthy()
  })
})
