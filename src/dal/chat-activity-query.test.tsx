/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { eq } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import { DatabaseProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, projectsTable } from '@/db/tables'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { getAllChatThreads } from './chat-threads'
import {
  getAllProjects,
  getProjectChatThreads,
  setChatThreadProject,
  setProjectPinned,
  updateProject,
  useProjects,
} from './projects'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(setupTestDatabase)
beforeEach(resetTestDatabase)
afterEach(cleanup)
afterAll(teardownTestDatabase)

/** Explicit times make recency assertions independent of the test clock. */
const idAt = (second: number) => uuidv7({ msecs: Date.UTC(2026, 9, 21, 12, 0, second) })

/** The newer project initially owns the newest chat; both projects have older chats to resume. */
const seedActivity = async () => {
  const db = getDb()
  const olderProject = idAt(1)
  const newerProject = idAt(2)
  const olderChat = idAt(3)
  const siblingChat = idAt(4)
  const newerChat = idAt(5)
  await db.insert(projectsTable).values([
    { id: olderProject, name: 'Older project' },
    { id: newerProject, name: 'Newer project' },
  ])
  await db.insert(chatThreadsTable).values([
    { id: olderChat, title: 'Older chat', projectId: olderProject },
    { id: siblingChat, title: 'Sibling chat', projectId: olderProject },
    { id: newerChat, title: 'Newer chat', projectId: newerProject },
  ])
  return { olderProject, newerProject, olderChat, siblingChat, newerChat }
}

it('moves an older chat and its project to the top on a new message, with creation as the empty-item fallback', async () => {
  const db = getDb()
  const { olderProject, newerProject, olderChat, siblingChat, newerChat } = await seedActivity()
  expect((await getAllProjects(db)).map((project) => project.id)).toEqual([newerProject, olderProject])
  expect((await getProjectChatThreads(db, olderProject)).map((chat) => chat.id)).toEqual([siblingChat, olderChat])

  await db.insert(chatMessagesTable).values({ id: idAt(6), chatThreadId: olderChat, role: 'user' })
  expect((await getAllChatThreads(db)).map((chat) => chat.id)).toEqual([olderChat, newerChat, siblingChat])
  expect((await getProjectChatThreads(db, olderProject)).map((chat) => chat.id)).toEqual([olderChat, siblingChat])
  expect((await getAllProjects(db)).map((project) => project.id)).toEqual([olderProject, newerProject])

  const emptyProject = idAt(7)
  await db.insert(projectsTable).values({ id: emptyProject, name: 'Empty project' })
  expect((await getAllProjects(db)).map((project) => project.id)).toEqual([emptyProject, olderProject, newerProject])
  await db.insert(chatMessagesTable).values({ id: idAt(8), chatThreadId: olderChat, role: 'assistant' })
  expect((await getAllProjects(db)).map((project) => project.id)).toEqual([olderProject, emptyProject, newerProject])
})

it('ignores deleted messages and chats, and follows live project membership', async () => {
  const db = getDb()
  const { olderProject, newerProject, olderChat, siblingChat, newerChat } = await seedActivity()
  const messageId = idAt(6)
  await db.insert(chatMessagesTable).values({ id: messageId, chatThreadId: olderChat, role: 'user' })
  await setChatThreadProject(db, olderChat, newerProject)
  expect((await getAllProjects(db)).map((project) => project.id)).toEqual([newerProject, olderProject])
  expect((await getProjectChatThreads(db, olderProject)).map((chat) => chat.id)).toEqual([siblingChat])
  expect((await getProjectChatThreads(db, newerProject)).map((chat) => chat.id)).toEqual([olderChat, newerChat])

  await setChatThreadProject(db, olderChat, olderProject)
  await db
    .update(chatMessagesTable)
    .set({ deletedAt: '2026-10-21T13:00:00Z' })
    .where(eq(chatMessagesTable.id, messageId))
  expect((await getAllChatThreads(db)).map((chat) => chat.id)).toEqual([newerChat, siblingChat, olderChat])
  expect((await getAllProjects(db)).map((project) => project.id)).toEqual([newerProject, olderProject])

  await db.insert(chatMessagesTable).values({ id: idAt(7), chatThreadId: olderChat, role: 'assistant' })
  await db.update(chatThreadsTable).set({ deletedAt: '2026-10-21T13:00:00Z' }).where(eq(chatThreadsTable.id, olderChat))
  expect((await getAllChatThreads(db)).map((chat) => chat.id)).toEqual([newerChat, siblingChat])
  expect((await getAllProjects(db)).map((project) => project.id)).toEqual([newerProject, olderProject])
  await db.update(projectsTable).set({ deletedAt: '2026-10-21T13:00:00Z' }).where(eq(projectsTable.id, newerProject))
  expect((await getAllProjects(db)).map((project) => project.id)).toEqual([olderProject])
})

it('keeps explicit pin order first and does not count project metadata edits as chat activity', async () => {
  const db = getDb()
  const { olderProject, newerProject, olderChat } = await seedActivity()
  await updateProject(db, olderProject, { name: 'Renamed project' })
  expect((await getAllProjects(db)).map((project) => project.id)).toEqual([newerProject, olderProject])
  await setProjectPinned(db, newerProject, 0)
  await setProjectPinned(db, olderProject, 1)
  const unpinned = idAt(8)
  await db.insert(projectsTable).values({ id: unpinned, name: 'Newest unpinned project' })
  await db.insert(chatMessagesTable).values({ id: idAt(9), chatThreadId: olderChat, role: 'user' })
  expect((await getAllProjects(db)).map((project) => project.id)).toEqual([newerProject, olderProject, unpinned])
})

const ActivityProbe = ({ projectId }: { projectId: string }) => {
  const projects = useProjects()
  const { data: chats = [] } = useQuery({
    queryKey: ['chatThreads'],
    query: toCompilableQuery(getAllChatThreads(getDb())),
  })
  return (
    <>
      <output aria-label="Projects">{projects.map((project) => project.name).join(', ')}</output>
      <output aria-label="Chats">{chats.map((chat) => chat.title).join(', ')}</output>
      <output aria-label="Project chats">
        {chats
          .filter((chat) => chat.projectId === projectId)
          .map((chat) => chat.title)
          .join(', ')}
      </output>
    </>
  )
}

it('reactively reorders projects and chats when only the messages table changes', async () => {
  const { olderProject, olderChat } = await seedActivity()
  const { triggerChange } = renderWithReactivity(<ActivityProbe projectId={olderProject} />, {
    tables: ['projects', 'chat_threads', 'chat_messages'],
    wrapper: ({ children }) => <DatabaseProvider db={getDb()}>{children}</DatabaseProvider>,
  })
  await waitForElement(() => screen.queryByText('Newer project, Older project'))
  expect(screen.getByRole('status', { name: 'Chats' })).toHaveTextContent('Newer chat, Sibling chat, Older chat')
  expect(screen.getByRole('status', { name: 'Project chats' })).toHaveTextContent('Sibling chat, Older chat')
  await getDb()
    .insert(chatMessagesTable)
    .values({ id: idAt(6), chatThreadId: olderChat, role: 'user' })
  triggerChange(['chat_messages'])
  await act(async () => {
    await getClock().runAllAsync()
  })
  expect(screen.getByRole('status', { name: 'Projects' })).toHaveTextContent('Older project, Newer project')
  expect(screen.getByRole('status', { name: 'Chats' })).toHaveTextContent('Older chat, Newer chat, Sibling chat')
  expect(screen.getByRole('status', { name: 'Project chats' })).toHaveTextContent('Older chat, Sibling chat')
})
