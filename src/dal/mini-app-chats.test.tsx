/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { chatThreadsTable } from '@/db/tables'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { useMiniAppChats } from './mini-app-chats'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(setupTestDatabase)
beforeEach(resetTestDatabase)
afterEach(cleanup)
afterAll(teardownTestDatabase)

const ChatListProbe = ({ sourceChatId }: { sourceChatId?: string }) => {
  const chats = useMiniAppChats('app', sourceChatId)
  return <output aria-label="Mini app chats">{chats.map((chat) => chat.title).join(', ')}</output>
}

it('includes the source chat only when requested and excludes unrelated or deleted chats', async () => {
  const db = getDb()
  const sourceChatId = uuidv7()
  const appChatId = uuidv7()
  const deletedChatId = uuidv7()
  await db.insert(chatThreadsTable).values([
    { id: sourceChatId, title: 'Source' },
    { id: appChatId, title: 'App chat', miniAppId: 'app' },
    { id: uuidv7(), title: 'Unrelated', miniAppId: 'other-app' },
    { id: deletedChatId, title: 'Deleted', miniAppId: 'app', deletedAt: '2026-11-02T00:00:00Z' },
  ])
  const { rerender } = renderWithReactivity(<ChatListProbe sourceChatId={sourceChatId} />, {
    tables: ['chat_threads', 'chat_messages'],
    wrapper: ({ children }) => <DatabaseProvider db={db}>{children}</DatabaseProvider>,
  })
  expect(await waitForElement(() => screen.queryByText('App chat, Source'))).toBeInTheDocument()

  rerender(<ChatListProbe />)
  expect(await waitForElement(() => screen.queryByText('App chat', { exact: true }))).toBeInTheDocument()

  rerender(<ChatListProbe sourceChatId={deletedChatId} />)
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(screen.getByRole('status', { name: 'Mini app chats' })).toHaveTextContent(/^App chat$/)
})
