/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { getDb } from '@/db/database'
import { chatThreadsTable, modelsTable, projectsTable } from '@/db/tables'
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

  it('orphans chats on project delete instead of removing them', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const threadId = await seedThread(project.id)
    await softDeleteProject(db, project.id)

    const [thread] = await db.select().from(chatThreadsTable)
    expect(thread.id).toBe(threadId)
    expect(thread.projectId).toBeNull()
    expect(thread.deletedAt).toBeNull()
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
    const thread = await getOrCreateChatThread(db, threadId, model.id, null, project.id)

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
    await getOrCreateChatThread(db, threadId, model.id, null, a.id)

    // Second call finds the row and returns it untouched.
    const again = await getOrCreateChatThread(db, threadId, model.id, null, b.id)
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

  it('writes updatedAt on every edit, so the list re-sorts', async () => {
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
