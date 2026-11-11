/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import * as tauri from '@tauri-apps/api/core'
import * as platform from '@/lib/platform'
import { useSshEnvironmentsStore, type SshEnvironment } from '@/agent-execution/ssh-environments'
import { useSshEnvironmentStatus } from '@/agent-execution/use-ssh-environment-status'
import { useAgentExecutionStore } from '@/agent-execution/store'
import { createProject } from '@/dal/projects'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { ProjectSshStatus } from './project-ssh-status'

const environment: SshEnvironment = {
  id: 'edfa69dd-fe35-4bbe-a745-026769cbb913',
  name: 'OrbStack',
  host: 'orb',
  cwd: '~',
  authentication: 'agent',
  deletedAt: null,
}

/** Exercise the same explicit check used by the settings page. */
const CheckConnection = () => {
  const { refresh } = useSshEnvironmentStatus(environment.id)
  return <button onClick={refresh}>Check connection</button>
}

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  await resetTestDatabase()
  useSshEnvironmentsStore.setState({ environments: {}, connectionStatuses: {} })
  useAgentExecutionStore.setState({ byThread: {}, byProject: {} })
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  spyOn(tauri, 'invoke').mockClear()
})
afterEach(() => {
  cleanup()
  mock.restore()
  useSshEnvironmentsStore.setState({ environments: {}, connectionStatuses: {} })
  useAgentExecutionStore.setState({ byThread: {}, byProject: {} })
})

/** Create a project with its real synced environment declaration. */
const createSshProject = () =>
  createProject(getDb(), {
    name: 'Remote project',
    execution: { location: 'ssh', environmentId: environment.id, cwd: '~/project', access: 'ask' },
  })

/** Settle database queries and React Query notifications without expiring the status. */
const settle = async () => {
  await act(async () => {
    await getClock().tickAsync(50)
  })
}

it('automatically shares status across projects and retains successful checks', async () => {
  const first = await createSshProject()
  const second = await createSshProject()
  const pending = Promise.withResolvers<unknown>()
  const invoke = spyOn(tauri, 'invoke').mockImplementation(
    async <T,>(command: string): Promise<T> =>
      (command === 'agent_ssh_request' ? await pending.promise : undefined) as T,
  )
  render(
    <>
      <CheckConnection />
      <ProjectSshStatus projectId={first.id} />
      <ProjectSshStatus projectId={second.id} />
    </>,
    { wrapper: createTestProvider() },
  )
  await settle()
  expect(screen.getAllByRole('status', { name: 'Checking connection' })).toHaveLength(2)

  fireEvent.click(screen.getByRole('button', { name: 'Check connection' }))
  await settle()
  expect(screen.getAllByRole('status', { name: 'Checking connection' })).toHaveLength(2)
  await act(async () => {
    pending.resolve({ cwd: '/remote', platform: 'linux' })
    await getClock().tickAsync(50)
  })
  for (const indicator of screen.getAllByRole('status', { name: 'Connected' })) {
    expect(indicator).toHaveClass('bg-green-500')
  }
  expect(invoke.mock.calls.filter(([command]) => command === 'agent_ssh_request')).toHaveLength(1)

  await act(async () => {
    await getClock().tickAsync(30_001)
  })
  expect(screen.getAllByRole('status', { name: 'Connected' })).toHaveLength(2)
  expect(invoke.mock.calls.filter(([command]) => command === 'agent_ssh_request')).toHaveLength(1)
})

it.each(['missing', 'deleted', 'web'] as const)('keeps a red indicator when the environment is %s', async (state) => {
  const project = await createSshProject()
  if (state === 'missing') {
    useSshEnvironmentsStore.setState({ environments: {}, connectionStatuses: {} })
  } else if (state === 'deleted') {
    useSshEnvironmentsStore.getState().deleteEnvironment(environment.id)
  } else {
    spyOn(platform, 'isTauriDesktop').mockReturnValue(false)
  }
  render(<ProjectSshStatus projectId={project.id} />, { wrapper: createTestProvider() })
  await settle()
  expect(screen.getByRole('status', { name: 'Disconnected' })).toHaveClass('bg-destructive')
})

it('does not show an SSH indicator for sandbox, computer, or cloud projects', async () => {
  const projects = await Promise.all(
    (['sandbox', 'computer', 'cloud'] as const).map((location) =>
      createProject(getDb(), {
        name: location,
        execution: location === 'computer' ? { location, cwd: '/local', access: 'ask' } : { location, access: 'ask' },
      }),
    ),
  )
  render(
    <>
      {projects.map((project) => (
        <ProjectSshStatus key={project.id} projectId={project.id} />
      ))}
    </>,
    { wrapper: createTestProvider() },
  )
  await settle()
  expect(screen.queryByRole('status')).toBeNull()
})
