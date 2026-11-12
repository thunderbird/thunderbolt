/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import * as projects from '@/dal/projects'
import * as platform from '@/lib/platform'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { useAgentExecutionStore } from '@/agent-execution/store'
import { getProjectExecution } from '@/agent-execution/project-execution'
import { useProjectExecution } from '@/agent-execution/use-project-execution'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { useProjectEditorState } from './use-project-editor-state'

const execution = { location: 'computer', cwd: '/original', access: 'ask' } as const
const values = { name: 'Project', icon: null, description: '', instructions: '' }

beforeEach(async () => {
  await resetTestDatabase()
  useAgentExecutionStore.setState({ byProject: {}, byThread: {} })
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
})
afterEach(() => {
  cleanup()
  mock.restore()
  useAgentExecutionStore.setState({ byProject: {}, byThread: {} })
})
afterAll(teardownTestDatabase)

it('does not grant full access when the details save fails', async () => {
  const project = await projects.createProject(getDb(), { name: 'Project', execution })
  spyOn(projects, 'updateProject').mockRejectedValue(new Error('Save failed'))
  const { result } = renderHook(() => useProjectEditorState(project.id), { wrapper: createTestProvider() })
  await act(async () => {
    await expect(result.current.submit({ ...values, execution: { ...execution, access: 'full' } })).rejects.toThrow(
      'Save failed',
    )
  })
  expect(await getProjectExecution(getDb(), project.id)).toEqual(execution)
})

it('refuses to apply a pending grant to a different working folder', async () => {
  const project = await projects.createProject(getDb(), { name: 'Project', execution })
  const saved = Promise.withResolvers<void>()
  spyOn(projects, 'updateProject').mockReturnValue(saved.promise)
  const { result } = renderHook(() => useProjectEditorState(project.id), { wrapper: createTestProvider() })
  const next = { ...execution, cwd: '/different' }
  await act(async () => {
    const pending = result.current.submit({ ...values, execution: { ...execution, access: 'full' } })
    useAgentExecutionStore.getState().setProjectExecution(project.id, next)
    saved.resolve()
    await expect(pending).rejects.toThrow('working environment changed')
  })
  expect(await getProjectExecution(getDb(), project.id)).toEqual(next)
})

it('does not restore a grant after the user identity changes during save', async () => {
  const project = await projects.createProject(getDb(), { name: 'Project', execution })
  const saved = Promise.withResolvers<void>()
  spyOn(projects, 'updateProject').mockReturnValue(saved.promise)
  const { result } = renderHook(() => useProjectEditorState(project.id), { wrapper: createTestProvider() })
  await act(async () => {
    const pending = result.current.submit({ ...values, execution: { ...execution, access: 'full' } })
    invalidateIdentityLifetime()
    saved.resolve()
    await expect(pending).rejects.toThrow()
  })
  expect(await getProjectExecution(getDb(), project.id)).toEqual(execution)
})

it('editing only details preserves a grant changed elsewhere while the editor was open', async () => {
  const project = await projects.createProject(getDb(), { name: 'Project', execution })
  const { result } = renderHook(() => useProjectEditorState(project.id), { wrapper: createTestProvider() })
  const full = { ...execution, access: 'full' } as const
  act(() => useAgentExecutionStore.getState().setProjectExecution(project.id, full))
  await act(async () => result.current.submit(values))
  expect(await getProjectExecution(getDb(), project.id)).toEqual(full)
})

it.each(['/original', '/different'])(
  'binding a computer folder retains Full access only for the originally approved folder (%s)',
  async (cwd) => {
    const project = await projects.createProject(getDb(), {
      name: 'Project',
      execution: { ...execution, access: 'full' },
    })
    const { result } = renderHook(() => useProjectExecution(project.id), { wrapper: createTestProvider() })
    await act(() => getClock().tickAsync(50))
    act(() => result.current.bindComputer(cwd))
    expect(await getProjectExecution(getDb(), project.id)).toEqual({
      location: 'computer',
      cwd,
      access: cwd === execution.cwd ? 'full' : 'ask',
    })
  },
)
