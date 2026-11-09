/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { ContentViewProvider } from '@/content-view/context'
import { ExternalLinkDialogProvider } from '@/components/chat/markdown-utils'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'bun:test'
import { SharedTranscript } from './shared-transcript'
import type { ShareSnapshot } from './snapshot'

afterEach(cleanup)

const snapshot: ShareSnapshot = {
  version: 1,
  title: 'Trip ideas',
  messages: [
    {
      id: 'u1',
      role: 'user',
      parts: [
        { type: 'text', text: 'Plan a weekend in Lisbon' },
        { type: 'data-attachment', data: { filename: 'itinerary.pdf', mimeType: 'application/pdf' } },
      ],
    },
    { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Start at the Alfama district.' }] },
  ],
}

/**
 * The viewer renders with no chat session and no database provider: a
 * component that reached for either would throw here.
 */
it('renders both sides of a shared chat with no chat session or database', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ContentViewProvider>
        <ExternalLinkDialogProvider>
          <SharedTranscript shareId="share-1" version="v1" snapshot={snapshot} />
        </ExternalLinkDialogProvider>
      </ContentViewProvider>
    </QueryClientProvider>,
  )

  expect(screen.getByText('Plan a weekend in Lisbon')).toBeInTheDocument()
  expect(screen.getByText('Start at the Alfama district.')).toBeInTheDocument()
  // The attachment shows its name only: the file never left the sharer's device.
  expect(screen.getByTitle('itinerary.pdf')).toBeInTheDocument()
})
