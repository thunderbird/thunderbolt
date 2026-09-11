/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { HttpClientProvider } from '@/contexts/http-client-context'
import { createSpyHttpClient } from '@/test-utils/http-client-spy'
import { AuthContext } from '@/contexts/auth-context'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockChatInstance } from '@/test-utils/chat-store-mocks'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { ShareDebugTranscriptAction } from './share-debug-transcript-action'

it('offers transcript sharing to anonymous sessions', () => {
  const authClient = createMockAuthClient({
    session: {
      user: { id: 'anonymous-user', email: 'anonymous@example.com', isAnonymous: true },
    },
  })

  render(
    <AuthContext.Provider value={{ authClient }}>
      <HttpClientProvider httpClient={createSpyHttpClient().httpClient}>
        <ShareDebugTranscriptAction chatInstance={createMockChatInstance([])} threadId="thread-1" />
      </HttpClientProvider>
    </AuthContext.Provider>,
  )

  expect(screen.getByRole('button', { name: 'Share debug transcript' })).toBeTruthy()
})
