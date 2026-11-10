/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createProject, updateProject } from '@/dal/projects'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { projectsTable, settingsTable } from '@/db/tables'
import * as platform from '@/lib/platform'
import { useAgentExecutionStore } from './store'
import {
  getProjectExecution,
  getProjectExecutionQuery,
  parseProjectExecutionLocation,
  projectExecutionKey,
  resolveProjectExecution,
} from './project-execution'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(() => mock.restore())
beforeEach(async () => {
  await getDb().delete(projectsTable)
  await getDb().delete(settingsTable)
  useAgentExecutionStore.setState({ byProject: {}, byThread: {} })
})

it('creates immutable project environment atomically and stores paths/access only on this device', async () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  const execution = { location: 'computer', cwd: '/private/working-folder', access: 'full' } as const
  const project = await createProject(getDb(), { name: 'Local work', execution })
  expect(await getProjectExecutionQuery(getDb(), project.id)).toEqual([
    { value: '{"version":1,"location":"computer"}' },
  ])
  expect(await getProjectExecution(getDb(), project.id)).toEqual(execution)
  await updateProject(getDb(), project.id, { name: 'Renamed' })
  expect(await getProjectExecution(getDb(), project.id)).toEqual(execution)
  expect(useAgentExecutionStore.getState().byThread).toEqual({})
})

it('refuses a computer project on another device until its local folder is bound', async () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  const project = await createProject(getDb(), {
    name: 'Computer project',
    execution: { location: 'computer', cwd: '/workspace', access: 'ask' },
  })
  useAgentExecutionStore.setState({ byProject: {} })
  await expect(getProjectExecution(getDb(), project.id)).rejects.toThrow('Choose its folder')
  useAgentExecutionStore
    .getState()
    .setProjectExecution(project.id, { location: 'computer', cwd: '/other-device/workspace', access: 'ask' })
  expect(await getProjectExecution(getDb(), project.id)).toEqual({
    location: 'computer',
    cwd: '/other-device/workspace',
    access: 'ask',
  })
  expect(() =>
    resolveProjectExecution('computer', useAgentExecutionStore.getState().byProject[project.id], false),
  ).toThrow('desktop app')
})

it('keeps old projects in sandbox, ignores per-chat overrides and rejects corrupt configuration', async () => {
  await getDb().insert(projectsTable).values({ id: 'old-project', name: 'Existing' })
  useAgentExecutionStore.getState().setExecution('chat', { location: 'computer', cwd: '/unrelated', access: 'full' })
  expect(await getProjectExecution(getDb(), 'old-project')).toEqual({ location: 'sandbox', access: 'ask' })
  await getDb()
    .insert(settingsTable)
    .values({ key: projectExecutionKey('old-project'), value: '{"version":2,"location":"computer"}' })
  await expect(getProjectExecution(getDb(), 'old-project')).rejects.toThrow('project environment is invalid')
  expect(parseProjectExecutionLocation('{"version":1,"location":"cloud"}')).toBe('cloud')
})

it('rolls back the project and provisional local binding if its synced environment cannot be saved', async () => {
  const db = getDb()
  await db.run(
    sql`CREATE TEMP TRIGGER reject_environment BEFORE INSERT ON settings WHEN NEW.key LIKE 'project-execution:%' BEGIN SELECT RAISE(ABORT, 'environment write rejected'); END`,
  )
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(createProject(db, { name: 'Rollback' })).rejects.toThrow()
    expect(await db.select().from(projectsTable)).toEqual([])
    expect(useAgentExecutionStore.getState().byProject).toEqual({})
  } finally {
    await db.run(sql`DROP TRIGGER reject_environment`)
    log.mockRestore()
  }
})

it('does not create an unusable native project or contaminate subsequent creation after failure', async () => {
  await expect(
    createProject(getDb(), { name: 'Bad', execution: { location: 'computer', cwd: ' ', access: 'ask' } }),
  ).rejects.toThrow('working folder')
  expect(await getDb().select().from(projectsTable)).toEqual([])
  const projects = await Promise.all([createProject(getDb(), { name: 'A' }), createProject(getDb(), { name: 'B' })])
  expect(projects).toHaveLength(2)
  expect(await getDb().select().from(settingsTable)).toHaveLength(2)
})
