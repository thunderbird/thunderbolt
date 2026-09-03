/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AuthContext } from '@/contexts/auth-context'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockChatInstance } from '@/test-utils/chat-store-mocks'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { ShareDebugTranscriptAction } from './share-debug-transcript-action'

it('hides identified transcript sharing from anonymous users', () => {
  const authClient = createMockAuthClient({
    session: {
      user: { id: 'anonymous-user', email: 'anonymous@example.com', isAnonymous: true },
    },
  })

  render(
    <AuthContext.Provider value={{ authClient }}>
      <ShareDebugTranscriptAction chatInstance={createMockChatInstance([])} threadId="thread-1" />
    </AuthContext.Provider>,
  )

  expect(screen.queryByRole('button', { name: 'Share debug transcript' })).toBeNull()
})
