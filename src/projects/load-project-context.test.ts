/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { getDb } from '@/db/database'
import { chatThreadsTable, projectsTable } from '@/db/tables'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createProject, softDeleteProject } from '@/dal/projects'
import { loadProjectContextForThread } from './load-project-context'

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

const seedThread = async (projectId: string | null, title = 'T') => {
  const id = uuidv7()
  await getDb().insert(chatThreadsTable).values({ id, title, projectId })
  return id
}

describe('loadProjectContextForThread', () => {
  it('returns null without a thread id', async () => {
    expect(await loadProjectContextForThread(getDb(), undefined)).toBeNull()
  })

  it('returns null for a chat that belongs to no project', async () => {
    const threadId = await seedThread(null)
    expect(await loadProjectContextForThread(getDb(), threadId)).toBeNull()
  })

  it('returns null for an unknown thread id', async () => {
    expect(await loadProjectContextForThread(getDb(), uuidv7())).toBeNull()
  })

  it('loads the name and instructions for a project chat', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'Q3', instructions: 'Be terse.' })
    const threadId = await seedThread(project.id)

    const context = await loadProjectContextForThread(db, threadId)

    expect(context?.id).toBe(project.id)
    expect(context?.prompt.name).toBe('Q3')
    expect(context?.prompt.instructions).toBe('Be terse.')
  })

  it('excludes the current chat from the searchable siblings', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const current = await seedThread(project.id, 'Current')
    const sibling = await seedThread(project.id, 'Sibling')

    const context = await loadProjectContextForThread(db, current)

    // The current chat's own history is already in context; searching it would
    // just return what the model can already see.
    expect(context?.siblingThreadIds).toEqual([sibling])
    expect(context?.titleByThreadId.get(sibling)).toBe('Sibling')
  })

  it('reports no siblings for the only chat in a project', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const only = await seedThread(project.id)
    expect((await loadProjectContextForThread(db, only))?.siblingThreadIds).toEqual([])
  })

  it('degrades to null when the project was deleted under the chat', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'Doomed' })
    const threadId = await seedThread(project.id)
    // `softDeleteProject` orphans chats, but a chat whose project_id somehow
    // outlives the project must lose its context rather than fail the send.
    await db.update(projectsTable).set({ deletedAt: new Date().toISOString() })

    expect(await loadProjectContextForThread(db, threadId)).toBeNull()
  })

  it('loses project context once the chat is orphaned by a delete', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const threadId = await seedThread(project.id)
    await softDeleteProject(db, project.id)
    expect(await loadProjectContextForThread(db, threadId)).toBeNull()
  })
})
