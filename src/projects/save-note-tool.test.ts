/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { getDb } from '@/db/database'
import { projectFilesTable, projectsTable } from '@/db/tables'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createProject, getProjectFiles, maxAgentNotes } from '@/dal/projects'
import { createSaveProjectNoteTool } from './save-note-tool'

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
})

/** Invoke the tool the way the AI SDK does. */
const callTool = async (projectId: string, input: { title: string; note: string }): Promise<string> => {
  const tool = createSaveProjectNoteTool({ db: getDb(), projectId, projectName: 'P' })
  // `execute` is optional on the SDK's Tool type; it is always present here.
  return (await tool.execute!(input, { toolCallId: 'call-1', messages: [] })) as string
}

describe('save_project_note', () => {
  it('writes the note as an assistant-origin knowledge document', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })

    const result = await callTool(project.id, { title: 'Preferred tone', note: 'Terse, no preamble.' })

    const [saved] = await getProjectFiles(db, project.id)
    expect(saved.filename).toBe('Preferred tone')
    expect(saved.content).toBe('Terse, no preamble.')
    // The origin is what badges it in the UI and sorts it last in the prompt budget.
    expect(saved.origin).toBe('agent')
    expect(result).toContain('Saved')
  })

  it('reports back to the model so it can tell the user', async () => {
    const project = await createProject(getDb(), { name: 'P' })
    const result = await callTool(project.id, { title: 'Budget', note: 'Cap is 50k.' })
    expect(result).toContain('Budget')
    expect(result).toContain('future chats')
  })

  it('saves nothing for an empty note', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    const result = await callTool(project.id, { title: 'Blank', note: '   ' })
    expect(await getProjectFiles(db, project.id)).toEqual([])
    expect(result).toContain('empty')
  })

  it('falls back to a default title rather than an unnamed row', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    await callTool(project.id, { title: '  ', note: 'Something.' })
    expect((await getProjectFiles(db, project.id))[0].filename).toBe('Note')
  })

  it('refuses at the cap instead of evicting an existing note', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    for (let i = 0; i < maxAgentNotes; i++) {
      await callTool(project.id, { title: `Note ${i}`, note: `Body ${i}` })
    }

    const result = await callTool(project.id, { title: 'One too many', note: 'Body' })

    // Choosing which remembered fact to discard is the user's call, not the tool's.
    expect(result).toContain('maximum')
    expect(await getProjectFiles(db, project.id)).toHaveLength(maxAgentNotes)
    const titles = (await getProjectFiles(db, project.id)).map((file) => file.filename)
    expect(titles).not.toContain('One too many')
    expect(titles).toContain('Note 0')
  })

  it('truncates an over-long note rather than rejecting it', async () => {
    const db = getDb()
    const project = await createProject(db, { name: 'P' })
    await callTool(project.id, { title: 'Long', note: 'x'.repeat(5_000) })
    const [saved] = await getProjectFiles(db, project.id)
    expect(saved.content.length).toBeLessThan(5_000)
    expect(saved.content.length).toBeGreaterThan(0)
  })

  it('scopes notes to the project it was built for', async () => {
    const db = getDb()
    const a = await createProject(db, { name: 'A' })
    const b = await createProject(db, { name: 'B' })
    await callTool(a.id, { title: 'For A', note: 'Body' })
    expect(await getProjectFiles(db, b.id)).toEqual([])
  })
})
