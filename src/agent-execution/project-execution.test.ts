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
import { useSshEnvironmentsStore } from './ssh-environments'
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
  useSshEnvironmentsStore.setState({ environments: {} })
})

it('fixes the SSH identity at project creation and syncs neither connection details nor grants', async () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  const environmentId = crypto.randomUUID()
  useSshEnvironmentsStore.getState().saveEnvironment({
    id: environmentId,
    name: 'VM',
    host: 'private-vm',
    username: 'private-user',
    port: 2222,
    authentication: 'key',
    identityFile: '/private/key',
    cwd: '/remote/project',
    deletedAt: null,
  })
  const execution = { location: 'ssh', environmentId, cwd: '/remote/project', access: 'full' } as const
  const project = await createProject(getDb(), { name: 'SSH project', execution })
  const rows = await getProjectExecutionQuery(getDb(), project.id)
  expect(JSON.parse(rows[0].value!)).toEqual({ version: 1, location: 'ssh', environmentId })
  expect(rows[0].value).not.toContain('private')
  expect(await getProjectExecution(getDb(), project.id)).toEqual(execution)
  useAgentExecutionStore.getState().setExecution('chat', { location: 'sandbox', access: 'full' })
  await updateProject(getDb(), project.id, { name: 'Renamed SSH project' })
  expect(await getProjectExecution(getDb(), project.id)).toEqual(execution)

  // An unrelated saved grant cannot redirect the immutable project or grant full access.
  useAgentExecutionStore
    .getState()
    .setProjectExecution(project.id, { location: 'computer', cwd: '/local', access: 'full' })
  expect(await getProjectExecution(getDb(), project.id)).toEqual({ ...execution, access: 'ask' })
  useSshEnvironmentsStore.getState().deleteEnvironment(environmentId)
  await expect(getProjectExecution(getDb(), project.id)).rejects.toThrow('SSH environment that is unavailable')
  expect(JSON.parse((await getProjectExecutionQuery(getDb(), project.id))[0].value!)).toEqual({
    version: 1,
    location: 'ssh',
    environmentId,
  })
})

it('refuses SSH projects in web/mobile and rejects a declaration without its environment identity', () => {
  expect(() =>
    resolveProjectExecution({ location: 'ssh', environmentId: crypto.randomUUID() }, undefined, false),
  ).toThrow('desktop app')
  expect(() => parseProjectExecutionLocation('{"version":1,"location":"ssh"}')).toThrow(
    'project environment is invalid',
  )
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
    resolveProjectExecution({ location: 'computer' }, useAgentExecutionStore.getState().byProject[project.id], false),
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
