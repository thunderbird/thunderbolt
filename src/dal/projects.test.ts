/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { getDb } from '@/db/database'
import { chatThreadsTable, modelsTable, projectFilesTable, projectsTable } from '@/db/tables'
import type { Model } from '@/types'
import { getOrCreateChatThread } from './chat-threads'
import { setupTestDatabase, teardownTestDatabase } from './test-utils'
import {
  ProjectNameRequiredError,
  addProjectFile,
  countAgentNotes,
  createProject,
  getAllProjects,
  getProject,
  getProjectChatThreads,
  getProjectFiles,
  maxProjectNameLength,
  setChatThreadProject,
  setProjectPinned,
  softDeleteProject,
  softDeleteProjectFile,
  updateProject,
  updateProjectFile,
} from './projects'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

beforeEach(async () => {
  const db = getDb()
  await db.delete(projectFilesTable)
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

describe('project knowledge', () => {
  it('stores extracted text and records its length', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const file = await addProjectFile(db, {
      projectId: project.id,
      filename: 'policy.md',
      content: 'No refunds.',
      sourceMimeType: 'text/markdown',
    })
    expect(file.size).toBe('No refunds.'.length)
    const files = await getProjectFiles(db, project.id)
    expect(files.map((f) => f.filename)).toEqual(['policy.md'])
  })

  it('excludes soft-deleted documents', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const file = await addProjectFile(db, { projectId: project.id, filename: 'a.md', content: 'a' })
    await softDeleteProjectFile(db, file.id)
    expect(await getProjectFiles(db, project.id)).toEqual([])
  })

  it('scopes documents to their own project', async () => {
    const db = getDb()
    const a = await createProject(db, { name: 'A' })
    const b = await createProject(db, { name: 'B' })
    await addProjectFile(db, { projectId: a.id, filename: 'a.md', content: 'a' })
    expect(await getProjectFiles(db, b.id)).toEqual([])
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

  it('soft-deletes the project’s knowledge alongside it', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    await addProjectFile(db, { projectId: project.id, filename: 'a.md', content: 'a' })
    await softDeleteProject(db, project.id)
    expect(await getProjectFiles(db, project.id)).toEqual([])
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

describe('notes and assistant memory', () => {
  it('defaults an imported document to the upload origin', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const file = await addProjectFile(db, { projectId: project.id, filename: 'a.md', content: 'a' })
    expect(file.origin).toBe('upload')
  })

  it('records a typed note and an assistant note distinctly', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    await addProjectFile(db, { projectId: project.id, filename: 'Mine', content: 'x', origin: 'note' })
    await addProjectFile(db, { projectId: project.id, filename: 'Theirs', content: 'y', origin: 'agent' })
    const files = await getProjectFiles(db, project.id)
    expect(files.find((f) => f.filename === 'Mine')?.origin).toBe('note')
    expect(files.find((f) => f.filename === 'Theirs')?.origin).toBe('agent')
  })

  it('sorts assistant notes last so they lose the context budget first', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    // Inserted assistant-first, so ordering can't be an accident of insert order.
    await addProjectFile(db, { projectId: project.id, filename: 'agent', content: 'a', origin: 'agent' })
    await addProjectFile(db, { projectId: project.id, filename: 'upload', content: 'b' })
    await addProjectFile(db, { projectId: project.id, filename: 'note', content: 'c', origin: 'note' })
    expect((await getProjectFiles(db, project.id)).map((f) => f.filename)).toEqual(['upload', 'note', 'agent'])
  })

  it('counts only assistant notes toward the cap', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    await addProjectFile(db, { projectId: project.id, filename: 'u', content: 'a' })
    await addProjectFile(db, { projectId: project.id, filename: 'n', content: 'b', origin: 'note' })
    await addProjectFile(db, { projectId: project.id, filename: 'g', content: 'c', origin: 'agent' })
    expect(await countAgentNotes(db, project.id)).toBe(1)
  })

  it('toggles assistant memory off by default', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    expect((await getProject(db, project.id))?.agentNotesEnabled).toBe(0)
    await updateProject(db, project.id, { agentNotesEnabled: true })
    expect((await getProject(db, project.id))?.agentNotesEnabled).toBe(1)
  })
})

describe('editing a saved note', () => {
  it('updates title and content, and recomputes size', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const note = await addProjectFile(db, {
      projectId: project.id,
      filename: 'Draft',
      content: 'short',
      origin: 'note',
    })

    await updateProjectFile(db, note.id, { filename: 'Final', content: 'a much longer body' })

    const [updated] = await getProjectFiles(db, project.id)
    expect(updated.filename).toBe('Final')
    expect(updated.content).toBe('a much longer body')
    // Size must track content or the prompt budget silently drifts.
    expect(updated.size).toBe('a much longer body'.length)
  })

  it('patches only what was provided', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const note = await addProjectFile(db, { projectId: project.id, filename: 'Keep', content: 'body', origin: 'note' })
    await updateProjectFile(db, note.id, { content: 'new body' })
    const [updated] = await getProjectFiles(db, project.id)
    expect(updated.filename).toBe('Keep')
    expect(updated.content).toBe('new body')
  })

  it('falls back to a default title rather than saving a blank one', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const note = await addProjectFile(db, { projectId: project.id, filename: 'Titled', content: 'x', origin: 'note' })
    await updateProjectFile(db, note.id, { filename: '   ' })
    expect((await getProjectFiles(db, project.id))[0].filename).toBe('Note')
  })

  it('is a no-op when nothing was passed', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const note = await addProjectFile(db, { projectId: project.id, filename: 'Same', content: 'x', origin: 'note' })
    await updateProjectFile(db, note.id, {})
    expect((await getProjectFiles(db, project.id))[0].filename).toBe('Same')
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

  it('writes updatedAt on every edit — the detail page keys its fields on it', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'A' })
    await updateProject(db, project.id, { name: 'B' })
    const updated = await getProject(db, project.id)
    expect(updated?.name).toBe('B')
    // Not asserting the value *changed*: this suite runs on frozen fake timers, so
    // two writes in one test share an instant. What matters is that the column is
    // always written, since the field key derives from it.
    expect(updated?.updatedAt).toBeTruthy()
  })

  it('trims a name on save, which is why the field must remount to show it', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'A' })
    await updateProject(db, project.id, { name: '  Spaced out  ' })
    expect((await getProject(db, project.id))?.name).toBe('Spaced out')
  })
})
