/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { ContentViewProvider } from '@/content-view/context'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import { ExternalLinkDialogProvider } from './markdown-utils'
import { MobileUserMessage } from './mobile-user-message'

const message: UIMessage = {
  id: 'message-1',
  role: 'user',
  parts: [{ type: 'text', text: 'Selectable message text' }],
}

describe('MobileUserMessage', () => {
  it('keeps selectable text and copy actions above the backdrop', () => {
    const { container } = render(
      <ContentViewProvider>
        <ExternalLinkDialogProvider>
          <MobileUserMessage message={message} />
        </ExternalLinkDialogProvider>
      </ContentViewProvider>,
    )
    const messageText = screen.getByText('Selectable message text')
    const messageContainer = messageText.closest('[data-message-id]')
    const gestureTarget = messageContainer?.firstElementChild

    expect(messageText.closest('.cursor-text')).toHaveClass('select-text')
    expect(gestureTarget).not.toHaveAttribute('data-long-press')

    fireEvent.touchStart(messageText, { touches: [{ clientX: 10, clientY: 10 }] })
    expect(gestureTarget).toHaveAttribute('data-long-press')
    fireEvent.touchEnd(messageText)
    expect(gestureTarget).not.toHaveAttribute('data-long-press')

    const range = document.createRange()
    range.selectNodeContents(messageText)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    expect(selection?.rangeCount).toBe(1)

    fireEvent.contextMenu(messageText)

    expect(selection?.rangeCount).toBe(0)
    const copyAction = screen.getByRole('button', { name: 'Copy' })
    const backdrop = screen.getByRole('button', { name: 'Dismiss' })
    expect(gestureTarget).toHaveClass('z-50')
    expect(gestureTarget).toHaveAttribute('data-long-press')
    expect(gestureTarget).toContainElement(copyAction)
    expect(backdrop).toHaveClass('z-40')
    expect(container).toContainElement(backdrop)

    fireEvent.click(backdrop)
    expect(gestureTarget).not.toHaveAttribute('data-long-press')
    expect(messageText.closest('.cursor-text')).toHaveClass('select-text')
  })
})
