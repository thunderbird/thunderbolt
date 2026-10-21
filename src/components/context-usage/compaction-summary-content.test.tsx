/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { fauxAssistantMessage } from '@earendil-works/pi-ai'
import type { CompactionCheckpoint } from '@shared/agent-core'
import { CompactionSummaryContent } from './compaction-summary-content'

const checkpoint: CompactionCheckpoint = {
  version: 1,
  summary: '## Project decisions\n\nKeep **dark mode** and keyboard shortcuts.',
  tokensBefore: 8000,
  contextTokens: 2000,
  retainedTail: [
    {
      role: 'user',
      timestamp: 1,
      content: [
        { type: 'text', text: 'Implement the design' },
        { type: 'image', data: 'base64-image-payload', mimeType: 'image/png' },
      ],
    },
    {
      ...fauxAssistantMessage(''),
      content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: '/workspace/design.md' } }],
    },
    {
      role: 'toolResult',
      timestamp: 2,
      toolCallId: 'call-1',
      toolName: 'read',
      isError: false,
      content: [{ type: 'text', text: '<script>not executable</script>' }],
    },
  ],
}

afterEach(cleanup)

describe('CompactionSummaryContent', () => {
  it('renders the saved summary as Markdown and expands inert retained context on demand', () => {
    render(<CompactionSummaryContent checkpoint={checkpoint} onClose={() => {}} />)
    const dialog = screen.getByRole('region', { name: 'Compaction summary' })
    expect(within(dialog).getByRole('heading', { name: 'Project decisions' })).toBeInTheDocument()
    expect(within(dialog).getByText('dark mode').tagName).toBe('STRONG')
    expect(within(dialog).queryByText('Implement the design')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Retained messages and tool results' }))
    expect(within(dialog).getByText('Implement the design')).toBeInTheDocument()
    expect(within(dialog).getByText('Image retained')).toBeInTheDocument()
    expect(dialog.textContent).toContain('/workspace/design.md')
    expect(dialog.textContent).toContain('<script>not executable</script>')
    expect(dialog.innerHTML).not.toContain('base64-image-payload')
    expect(dialog.querySelector('script')).toBeNull()
    expect(within(dialog).queryByRole('textbox')).toBeNull()
  })

  it('omits empty retained context and closes through the shared sidebar header', () => {
    const onClose = mock()
    render(<CompactionSummaryContent checkpoint={{ ...checkpoint, retainedTail: [] }} onClose={onClose} />)
    expect(screen.queryByRole('button', { name: 'Retained messages and tool results' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
