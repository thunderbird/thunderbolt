/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { ContentViewProvider } from '@/content-view/context'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'bun:test'
import type { UIMessage } from 'ai'
import { DesktopUserMessage } from './desktop-user-message'
import { ExternalLinkDialogProvider } from './markdown-utils'

it('right-aligns the last-message action after the copy button', () => {
  const message: UIMessage = {
    id: 'message-1',
    role: 'user',
    parts: [{ type: 'text', text: 'User message' }],
  }

  render(
    <ContentViewProvider>
      <ExternalLinkDialogProvider>
        <DesktopUserMessage message={message} lastMessageAction={<button type="button">Share transcript</button>} />
      </ExternalLinkDialogProvider>
    </ContentViewProvider>,
  )

  const copyButton = screen.getByRole('button', { name: 'Copy message' })
  const shareButton = screen.getByRole('button', { name: 'Share transcript' })
  expect(copyButton.parentElement).toBe(shareButton.parentElement)
  expect(copyButton.parentElement).toHaveClass(
    'ml-auto',
    'w-fit',
    'opacity-0',
    'pointer-events-none',
    'group-hover/user-message:opacity-100',
    'group-hover/user-message:pointer-events-auto',
  )
  expect(copyButton.nextElementSibling).toBe(shareButton)
})
