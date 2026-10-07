/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PendingMiniAppApproval } from '@/chats/chat-store'
import { MiniAppApprovalPrompt } from './mini-app-approval-prompt'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

afterEach(cleanup)

const modelFacingDescription =
  'Change the status of one order. Valid statuses: open, shipped, cancelled. Use this when the user asks to ship, cancel or reopen an order.'

const pending = (overrides: Partial<PendingMiniAppApproval['tool']> = {}, args: unknown = {}): PendingMiniAppApproval =>
  ({
    tool: {
      name: 'set_order_status',
      description: modelFacingDescription,
      annotations: { readOnlyHint: false, title: 'Change an order status' },
      ...overrides,
    },
    args,
  }) as PendingMiniAppApproval

const renderPrompt = (approval: PendingMiniAppApproval, onDecide: (approved: boolean) => void = () => {}) =>
  render(<MiniAppApprovalPrompt pending={approval} appName="Order Book" onDecide={onDecide} />)

describe('MiniAppApprovalPrompt decisions', () => {
  /*
   * The component exists to call `onDecide`, and nothing here pressed a button
   * until now: eleven tests asserted structure, ordering, ARIA and focus, all of
   * which would have passed with both buttons wired to the same handler, or with
   * the booleans swapped, or with `onClick` dropped entirely.
   */
  it('approves when Approve is pressed', () => {
    const decisions: boolean[] = []
    renderPrompt(pending(), (approved) => decisions.push(approved))

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(decisions).toEqual([true])
  })

  it('denies when Deny is pressed', () => {
    const decisions: boolean[] = []
    renderPrompt(pending(), (approved) => decisions.push(approved))

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    expect(decisions).toEqual([false])
  })

  /** Pressing one must not report the other — the two labels sit side by side
   *  and a swapped handler is invisible to a structural assertion. */
  it('reports exactly one decision per press', () => {
    const decisions: boolean[] = []
    renderPrompt(pending(), (approved) => decisions.push(approved))

    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    expect(decisions).toEqual([false, true])
  })
})

describe('MiniAppApprovalPrompt', () => {
  it('leads with the author-written title, not the tool identifier', () => {
    renderPrompt(pending())
    expect(screen.getByText('Change an order status')).toBeTruthy()
  })

  it('falls back to the tool name when no title was declared', () => {
    const { container } = renderPrompt(pending({ annotations: { readOnlyHint: false } }))
    expect(container.querySelector('p')?.textContent).toBe('set_order_status')
  })

  it('does not repeat the identifier in the details when it is already the heading', () => {
    const { container } = renderPrompt(pending({ annotations: { readOnlyHint: false } }))
    expect(container.querySelectorAll('.font-mono')).toHaveLength(0)
  })

  /**
   * `description` is written for the model — long, and full of instructions
   * about when to call the tool. Someone deciding whether to allow it should not
   * have to read past that, so it lives behind the disclosure.
   */
  it('keeps the model-facing description out of the summary', () => {
    const { container } = renderPrompt(pending())
    const summary = container.querySelector('summary')

    expect(summary?.textContent).not.toContain(modelFacingDescription)
    expect(summary?.textContent).toContain('Order Book')
  })

  it('renders arguments as readable pairs rather than JSON', () => {
    renderPrompt(pending({}, { id: 'A-1041', status: 'shipped' }))

    expect(screen.getByText('id')).toBeTruthy()
    expect(screen.getByText('A-1041')).toBeTruthy()
    expect(screen.getByText('status')).toBeTruthy()
    expect(screen.getByText('shipped')).toBeTruthy()
  })

  it('still exposes the raw arguments underneath, for when the pairs are not enough', () => {
    const { container } = renderPrompt(pending({}, { id: 'A-1041' }))
    expect(container.querySelector('pre')?.textContent).toContain('"id": "A-1041"')
  })

  it('shows no argument list for a tool that takes none', () => {
    const { container } = renderPrompt(pending({}, {}))
    expect(container.querySelector('ul')).toBeNull()
  })

  it('renders a nested value as JSON rather than [object Object]', () => {
    renderPrompt(pending({}, { filter: { status: 'open' } }))
    expect(screen.getByText('{"status":"open"}')).toBeTruthy()
  })

  /*
   * Focus is deliberately left alone now that the prompt renders inline above
   * the composer rather than as a bar over the iframe. In the old placement a
   * keyboard user had to tab through the entire customer app to reach a decision
   * blocking them, so it grabbed focus; inline it is already in reading order,
   * and pulling focus out from under someone mid-sentence would be a new bug.
   */
  it('leaves focus where the user put it', () => {
    renderPrompt(pending())

    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Deny' }))
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Approve' }))
  })

  /** Deny first in DOM order: a stray Enter or a rushed Tab should land on the
   *  harmless one. The model can ask again; an unwanted write cannot be undone. */
  it('puts Deny before Approve', () => {
    renderPrompt(pending())
    const buttons = screen.getAllByRole('button').map((button) => button.textContent)

    expect(buttons.indexOf('Deny')).toBeLessThan(buttons.indexOf('Approve'))
  })

  /*
   * Named, but not `aria-modal`. It is inline content in the chat now, not an
   * overlay trapping interaction — claiming modality for something the user can
   * freely scroll past would misreport the page to a screen reader.
   */
  it('names itself for a screen reader instead of announcing a bare dialog', () => {
    renderPrompt(pending({ annotations: { readOnlyHint: false, title: 'Change an order status' } }))
    const dialog = screen.getByRole('dialog')

    expect(dialog.getAttribute('aria-modal')).toBeNull()
    expect(dialog).toHaveAccessibleName('Change an order status')
  })
})
