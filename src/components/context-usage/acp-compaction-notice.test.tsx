/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'bun:test'
import { ContentViewProvider, useContentView } from '@/content-view/context'
import type { AcpCompaction } from '@/acp/compaction'
import { AcpCompactionNotice } from './acp-compaction-notice'
import { CompactionSummaryContent } from './compaction-summary-content'

const Summary = () => {
  const { state, close } = useContentView()
  return state.type === 'compaction-summary' ? (
    <CompactionSummaryContent checkpoint={state.data} onClose={close} />
  ) : null
}

const show = (compaction: Partial<AcpCompaction>) =>
  render(
    <ContentViewProvider>
      <AcpCompactionNotice
        compaction={{ agentId: 'agent', sessionId: 's', compactionId: 'c', status: 'completed', ...compaction }}
      />
      <Summary />
    </ContentViewProvider>,
  )

afterEach(cleanup)

it('renders Markdown split across streamed summary chunks as one continuous document', () => {
  show({
    summary: ['Keep **auth', 'entication', '** safe.', '\n', '\n', '- Preserve credentials'].map((text) => ({
      type: 'text',
      text,
    })),
  })
  fireEvent.click(screen.getByRole('button', { name: /View summary/ }))
  expect(screen.getByText('authentication').tagName).toBe('STRONG')
  expect(screen.getByRole('listitem')).toHaveTextContent('Preserve credentials')
})

it.each([
  ['in_progress', 'Compacting…'],
  ['completed', 'Compacted'],
  ['failed', 'Compaction failed'],
  ['cancelled', 'Compaction cancelled'],
  ['future-state', 'Compaction'],
])('renders ACP status %s without inventing a summary', (status, label) => {
  show({ status })
  expect(screen.getByRole('status')).toHaveTextContent(label)
  expect(screen.queryByRole('button', { name: /View summary/ })).toBeNull()
})

it.each([undefined, null, [], [{ type: 'text' as const, text: '  ' }]].map((summary) => ({ summary })))(
  'omits inspection for an empty summary',
  ({ summary }) => {
    show({ summary })
    expect(screen.queryByRole('button', { name: /View summary/ })).toBeNull()
  },
)

it('shows a failed summary and literal agent error without executing embedded content', () => {
  const { container } = show({
    status: 'failed',
    error: '<script>failure</script>',
    summary: [{ type: 'text', text: 'Partial **summary** ![private](https://example.invalid/image)' }],
  })
  expect(screen.getByText('<script>failure</script>')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /View summary/ }))
  expect(screen.getByRole('region', { name: 'Compaction summary' })).toHaveTextContent('Partial summary private')
  expect(container.querySelector('script,img,audio,iframe')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retained messages and tool results' })).toBeNull()
})
