/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { afterAll, afterEach, beforeAll, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import { SignInModalProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createClient } from '@/lib/http'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import LegacyCloudAgentsRedirect from '@/settings/cloud-agents'
import ArtifactsPage from './artifacts'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(cleanup)

const LocationProbe = () => {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output data-testid="location">
        {location.pathname}
        {location.search}
      </output>
      <button onClick={() => navigate(-1)}>Back</button>
    </>
  )
}

it('redirects an existing artifact bookmark and replaces the obsolete route in browser history', () => {
  render(
    <MemoryRouter initialEntries={['/prior', '/settings/cloud-agents?artifact=saved&agent=old']} initialIndex={1}>
      <Routes>
        <Route path="/settings/cloud-agents" element={<LegacyCloudAgentsRedirect />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  )
  expect(screen.getByTestId('location')).toHaveTextContent('/artifacts?artifact=saved')
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByTestId('location')).toHaveTextContent('/prior')
})

it('shows and opens persisted chat artifacts for an anonymous user without cloud requests', async () => {
  const db = getDb()
  const threadId = uuidv7()
  const messageId = uuidv7()
  await db.insert(chatThreadsTable).values({ id: threadId, title: 'Offline chat' })
  await db.insert(chatMessagesTable).values({
    id: messageId,
    chatThreadId: threadId,
    parts: [
      {
        type: 'tool-render_html',
        toolCallId: 'preview',
        state: 'output-available',
        input: { title: 'Local report', html: '<h1>Saved locally</h1>' },
        output: { ok: true },
      },
    ],
  })
  const requests: string[] = []
  const Provider = createTestProvider({
    authClient: createMockAuthClient({ session: { user: { id: 'anonymous', email: '', isAnonymous: true } } }),
    httpClient: createClient({
      prefixUrl: 'https://example.test',
      fetch: async (request) => {
        requests.push(request instanceof Request ? request.url : String(request))
        return Response.json(null)
      },
    }),
  })
  render(
    <Provider>
      <SignInModalProvider>
        <MemoryRouter initialEntries={['/artifacts']}>
          <ArtifactsPage />
          <LocationProbe />
        </MemoryRouter>
      </SignInModalProvider>
    </Provider>,
  )
  await waitForElement(() => screen.queryByRole('button', { name: 'Open Local report' }))
  fireEvent.click(screen.getByRole('button', { name: 'Open Local report' }))
  expect(screen.getByTestId('location')).toHaveTextContent(`/artifacts?local=${messageId}-0`)
  expect(screen.getByRole('link', { name: 'Open original chat' })).toHaveAttribute('href', `/chats/${threadId}`)
  expect(requests.filter((url) => url.includes('/cloud-agents'))).toEqual([])
})
