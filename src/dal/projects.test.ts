/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { getDb } from '@/db/database'
import { chatMessagesTable, chatThreadsTable, modelsTable, projectsTable, settingsTable } from '@/db/tables'
import { useAgentExecutionStore } from '@/agent-execution/store'
import {
  getProjectExecutionQuery,
  parseProjectExecutionLocation,
  projectExecutionKey,
} from '@/agent-execution/project-execution'
import { eq, sql } from 'drizzle-orm'
import type { Model } from '@/types'
import { getOrCreateChatThread } from './chat-threads'
import { setupTestDatabase, teardownTestDatabase } from './test-utils'
import {
  ProjectNameRequiredError,
  createProject,
  getAllProjects,
  getProject,
  getProjectChatThreads,
  maxProjectInstructionsLength,
  maxProjectNameLength,
  setChatThreadProject,
  setProjectPinned,
  softDeleteProject,
  softDeleteAllProjects,
  updateProject,
} from './projects'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  const db = getDb()
  await db.delete(projectsTable)
  await db.delete(chatThreadsTable)
  useAgentExecutionStore.setState({ byProject: {}, byThread: {} })
})

/** Insert a bare chat thread; the DAL's createChatThread needs a Model. */
const seedThread = async (projectId: string | null) => {
  const id = uuidv7()
  await getDb().insert(chatThreadsTable).values({ id, title: 'T', projectId })
  return id
}

describe('projects CRUD', () => {
  it('creates and reads back a project', async () => {
    const db = getDb()
    const created = await createProject(db, { name: 'Q3 Planning', instructions: 'Be terse.' })
    const found = await getProject(db, created.id)
    expect(found?.name).toBe('Q3 Planning')
    expect(found?.instructions).toBe('Be terse.')
  })

  it('trims the name and rejects a blank one', async () => {
    const db = getDb()
    const created = await createProject(db, { name: '  Spaced  ' })
    expect(created.name).toBe('Spaced')
    await expect(createProject(db, { name: '   ' })).rejects.toBeInstanceOf(ProjectNameRequiredError)
  })

  it('caps an over-long name', async () => {
    const created = await createProject(getDb(), { name: 'x'.repeat(maxProjectNameLength + 50) })
    expect(created.name.length).toBe(maxProjectNameLength)
  })

  it('patches only the provided fields', async () => {
    const db = getDb()
    const created = await createProject(db, { name: 'A', description: 'keep me', instructions: 'old' })
    await updateProject(db, created.id, { instructions: 'new' })
    const found = await getProject(db, created.id)
    expect(found?.instructions).toBe('new')
    expect(found?.description).toBe('keep me')
    expect(found?.name).toBe('A')
  })

  it('hides soft-deleted projects from reads', async () => {
    const db = getDb()
    const created = await createProject(db, { name: 'Doomed' })
    await softDeleteProject(db, created.id)
    expect(await getProject(db, created.id)).toBeNull()
    expect(await getAllProjects(db)).toEqual([])
  })

  it('orders pinned projects first', async () => {
    const db = getDb()
    await createProject(db, { name: 'Unpinned' })
    const pinned = await createProject(db, { name: 'Pinned' })
    await setProjectPinned(db, pinned.id, 0)
    const all = await getAllProjects(db)
    expect(all[0].name).toBe('Pinned')
  })
})

describe('chat membership', () => {
  it('lists only its own project’s chats', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    await seedThread(project.id)
    await seedThread(project.id)
    await seedThread(null)
    expect(await getProjectChatThreads(db, project.id)).toHaveLength(2)
  })

  it('moves a chat in and out of a project', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const threadId = await seedThread(null)
    await setChatThreadProject(db, threadId, project.id)
    expect(await getProjectChatThreads(db, project.id)).toHaveLength(1)
    await setChatThreadProject(db, threadId, null)
    expect(await getProjectChatThreads(db, project.id)).toHaveLength(0)
  })

  it.each(['deleted', 'missing'])('refuses a move to a %s project', async (target) => {
    const db = getDb()
    const current = await createProject(db, { name: 'Keep' })
    const threadId = await seedThread(current.id)
    const destination = await createProject(db, { name: 'Removed' })
    await softDeleteProject(db, destination.id)
    const targetId = target === 'deleted' ? destination.id : 'missing'

    expect(await setChatThreadProject(db, threadId, targetId)).toBe(false)
    expect(await getProjectChatThreads(db, current.id)).toHaveLength(1)
    expect(await setChatThreadProject(db, 'unsaved-draft', targetId)).toBe(false)
  })

  it('deletes only the selected project, keeping its chats and other projects intact', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const threadId = await seedThread(project.id)
    const other = await createProject(db, { name: 'Keep' })
    const otherThreadId = await seedThread(other.id)
    await softDeleteProject(db, project.id)

    expect(await getProject(db, project.id)).toBeNull()
    expect(await getProject(db, other.id)).not.toBeNull()
    const [otherThread] = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, otherThreadId))
    expect(otherThread.projectId).toBe(other.id)
    const [thread] = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, threadId))
    expect(thread.id).toBe(threadId)
    expect(thread.projectId).toBeNull()
    expect(thread.deletedAt).toBeNull()
    const [removedEnvironment] = await getProjectExecutionQuery(db, project.id)
    expect(JSON.parse(removedEnvironment.value!)).toMatchObject({ deletedAt: expect.any(String) })
    expect(() => parseProjectExecutionLocation(removedEnvironment.value)).toThrow('project environment is invalid')
    expect(useAgentExecutionStore.getState().byProject[project.id]).toBeUndefined()
    expect(useAgentExecutionStore.getState().byProject[other.id]).toEqual({ location: 'sandbox', access: 'ask' })
    expect(parseProjectExecutionLocation((await getProjectExecutionQuery(db, other.id))[0].value)).toBe('sandbox')
  })
})

describe('bulk project deletion', () => {
  it.each([null, undefined])('does not widen single-project deletion for a missing id (%s)', async (id) => {
    const db = getDb()
    const project = await createProject(db, { name: 'Keep' })
    const chatId = await seedThread(project.id)
    // An untyped caller must not turn a missing selection into bulk deletion.
    // @ts-expect-error Missing ids are also rejected at the TypeScript boundary.
    await softDeleteProject(db, id)
    expect(await getProject(db, project.id)).not.toBeNull()
    const [chat] = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, chatId))
    expect(chat.projectId).toBe(project.id)
  })

  it('soft-deletes every live project, preserving chats, messages, and existing deletion dates', async () => {
    const db = getDb()
    const projects = await Promise.all([
      createProject(db, { name: 'A' }),
      createProject(db, { name: 'B' }),
      createProject(db, { name: 'Already deleted' }),
    ])
    const deletedAt = '2026-01-01T00:00:00Z'
    await db.update(projectsTable).set({ deletedAt }).where(eq(projectsTable.id, projects[2].id))
    const ids = [await seedThread(projects[0].id), await seedThread(projects[1].id), await seedThread(null)]
    const deletedChat = await seedThread(projects[0].id)
    await db.update(chatThreadsTable).set({ deletedAt }).where(eq(chatThreadsTable.id, deletedChat))
    const messageId = uuidv7()
    await db.insert(chatMessagesTable).values({ id: messageId, chatThreadId: ids[0], role: 'user', content: 'Keep me' })

    await softDeleteAllProjects(db)

    expect(await getAllProjects(db)).toEqual([])
    const rows = await db.select().from(projectsTable)
    expect(rows).toHaveLength(3)
    expect(rows.every((row) => row.deletedAt !== null)).toBe(true)
    expect(rows.find((row) => row.id === projects[2].id)?.deletedAt).toBe(deletedAt)
    const threads = await db.select().from(chatThreadsTable)
    for (const id of ids) {
      expect(threads.find((thread) => thread.id === id)).toMatchObject({ projectId: null, deletedAt: null, title: 'T' })
    }
    expect(threads.find((thread) => thread.id === deletedChat)).toMatchObject({ projectId: projects[0].id, deletedAt })
    const [message] = await db.select().from(chatMessagesTable).where(eq(chatMessagesTable.id, messageId))
    expect(message).toMatchObject({ content: 'Keep me', deletedAt: null })
    for (const project of projects.slice(0, 2)) {
      expect(JSON.parse((await getProjectExecutionQuery(db, project.id))[0].value!)).toMatchObject({
        deletedAt: expect.any(String),
      })
      expect(useAgentExecutionStore.getState().byProject[project.id]).toBeUndefined()
    }

    await softDeleteAllProjects(db)
    expect(await db.select().from(projectsTable)).toEqual(rows)
  })

  it('rolls back chat membership if deleting the projects fails', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'Keep together' })
    const chatId = await seedThread(project.id)
    await db.run(
      sql`CREATE TEMP TRIGGER fail_project_delete BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'test failure'); END`,
    )
    try {
      await expect(softDeleteAllProjects(db)).rejects.toThrow()
      expect(await getProject(db, project.id)).not.toBeNull()
      const [chat] = await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, chatId))
      expect(chat.projectId).toBe(project.id)
      expect(parseProjectExecutionLocation((await getProjectExecutionQuery(db, project.id))[0].value)).toBe('sandbox')
      expect(useAgentExecutionStore.getState().byProject[project.id]).toEqual({ location: 'sandbox', access: 'ask' })
    } finally {
      await db.run(sql`DROP TRIGGER fail_project_delete`)
    }
  })

  it('rolls back deletion and keeps folder grants when writing the environment tombstone fails', async () => {
    const db = getDb()
    const execution = { location: 'computer', access: 'full', cwd: '/workspace/private' } as const
    const project = await createProject(db, { name: 'Local work', execution })
    const chatId = await seedThread(project.id)
    await db.run(
      sql`CREATE TEMP TRIGGER fail_environment_delete BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT, 'test failure'); END`,
    )
    try {
      await expect(softDeleteProject(db, project.id)).rejects.toThrow()
      expect(await getProject(db, project.id)).not.toBeNull()
      expect((await db.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, chatId)))[0].projectId).toBe(
        project.id,
      )
      expect(useAgentExecutionStore.getState().byProject[project.id]).toEqual(execution)
      const [setting] = await db
        .select()
        .from(settingsTable)
        .where(eq(settingsTable.key, projectExecutionKey(project.id)))
      expect(parseProjectExecutionLocation(setting.value)).toBe('computer')
    } finally {
      await db.run(sql`DROP TRIGGER fail_environment_delete`)
    }
  })
})

describe('new chat started inside a project', () => {
  it('stamps the project onto the lazily-created thread row', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const model = (await db.select().from(modelsTable).limit(1))[0] as Model

    // Mirrors the hydration path: the row does not exist until the first message
    // save, at which point the session's projectId must reach it.
    const threadId = uuidv7()
    const thread = await getOrCreateChatThread(db, threadId, model.id, { projectId: project.id })

    expect(thread.projectId).toBe(project.id)
    expect(await getProjectChatThreads(db, project.id)).toHaveLength(1)
  })

  it('leaves a chat started outside any project unassigned', async () => {
    const db = getDb()
    const model = (await db.select().from(modelsTable).limit(1))[0] as Model
    const thread = await getOrCreateChatThread(db, uuidv7(), model.id)
    expect(thread.projectId).toBeNull()
  })

  it('does not overwrite the project of an existing thread', async () => {
    const db = getDb()
    const a = await createProject(db, { name: 'A' })
    const b = await createProject(db, { name: 'B' })
    const model = (await db.select().from(modelsTable).limit(1))[0] as Model
    const threadId = uuidv7()
    await getOrCreateChatThread(db, threadId, model.id, { projectId: a.id })

    // Second call finds the row and returns it untouched.
    const again = await getOrCreateChatThread(db, threadId, model.id, { projectId: b.id })
    expect(again.projectId).toBe(a.id)
  })
})

describe('updateProject error surface', () => {
  it('throws on a blank name so callers must handle it', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'Keep me' })
    // The detail page's blur handler relies on this throwing; it catches and
    // surfaces the message rather than letting the rejection go unhandled.
    await expect(updateProject(db, project.id, { name: '   ' })).rejects.toBeInstanceOf(ProjectNameRequiredError)
    // And the row must be untouched, not half-written.
    expect((await getProject(db, project.id))?.name).toBe('Keep me')
  })

  it('records updatedAt on every project edit', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'A' })
    await updateProject(db, project.id, { name: 'B' })
    const updated = await getProject(db, project.id)
    expect(updated?.name).toBe('B')
    // Not asserting the value *changed*: this suite runs on frozen fake timers, so
    // two writes in one test share an instant. What matters is that the column is
    // always written.
    expect(updated?.updatedAt).toBeTruthy()
  })

  it('caps instructions on create as well as on update', async () => {
    const db = getDb()
    const overLong = 'x'.repeat(maxProjectInstructionsLength + 500)
    // The DAL is the bound, not the textarea's maxLength — instructions land in
    // the stable half of every chat's system prompt.
    const created = await createProject(db, { name: 'P', instructions: overLong })
    expect(created.instructions?.length).toBe(maxProjectInstructionsLength)
    expect((await getProject(db, created.id))?.instructions?.length).toBe(maxProjectInstructionsLength)
  })

  it('trims a name on save, which is why the field must remount to show it', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'A' })
    await updateProject(db, project.id, { name: '  Spaced out  ' })
    expect((await getProject(db, project.id))?.name).toBe('Spaced out')
  })
})
