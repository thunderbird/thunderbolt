/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { MemoryRouter } from 'react-router'
import * as platform from '@/lib/platform'
import * as statusHook from '@/agent-execution/use-ssh-environment-status'
import { useSshEnvironmentsStore, type SshEnvironment } from '@/agent-execution/ssh-environments'
import { useAgentExecutionStore } from '@/agent-execution/store'
import { getProjectExecution } from '@/agent-execution/project-execution'
import { createProject, getProject } from '@/dal/projects'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { ProjectEditorDialog } from './project-editor-dialog'
import { ProjectExecutionSummary } from './project-execution-summary'

const environment: SshEnvironment = {
  id: 'edfa69dd-fe35-4bbe-a745-026769cbb913',
  name: 'My OrbStack',
  host: 'orb',
  cwd: '~',
  authentication: 'agent',
  deletedAt: null,
}

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  await resetTestDatabase()
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({ status: 'connected', error: null, refresh: mock() })
  useSshEnvironmentsStore.setState({ environments: {} })
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  useAgentExecutionStore.setState({ byThread: {}, byProject: {} })
})
afterEach(() => {
  cleanup()
  mock.restore()
  useSshEnvironmentsStore.setState({ environments: {} })
  useAgentExecutionStore.setState({ byThread: {}, byProject: {} })
})

/** Settle the saved declaration query without advancing unrelated timers. */
const settle = async () => {
  await act(async () => {
    await getClock().tickAsync(50)
  })
}

it('shows the fixed SSH name, status and project folder in settings, and preserves them when saving edits', async () => {
  const execution = {
    location: 'ssh' as const,
    environmentId: environment.id,
    cwd: '~/work/my-app',
    access: 'full' as const,
  }
  const project = await createProject(getDb(), { name: 'Remote work', execution })
  render(
    <MemoryRouter>
      <ProjectEditorDialog project={project} onClose={() => {}} />
    </MemoryRouter>,
    {
      wrapper: createTestProvider(),
    },
  )
  await settle()
  expect(screen.getByLabelText('Project environment')).toHaveTextContent('My OrbStack')
  expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()
  expect(screen.getByText('~/work/my-app')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Project environment' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Browse remote folders' })).toBeNull()
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed project' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await settle()
  expect((await getProject(getDb(), project.id))?.name).toBe('Renamed project')
  expect(await getProjectExecution(getDb(), project.id)).toEqual(execution)
})

it('shows the saved SSH choice even when this computer has no connection profile', async () => {
  const project = await createProject(getDb(), {
    name: 'Remote work',
    execution: {
      location: 'ssh',
      environmentId: environment.id,
      cwd: '~/project',
      access: 'ask',
    },
  })
  useSshEnvironmentsStore.setState({ environments: {} })
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({ status: 'unavailable', error: null, refresh: mock() })
  render(<ProjectExecutionSummary projectId={project.id} />, { wrapper: createTestProvider() })
  await settle()
  expect(screen.getByLabelText('Project environment')).toHaveTextContent('SSH environment unavailable')
  expect(screen.getByRole('status', { name: 'SSH environment unavailable' })).toBeInTheDocument()
  expect(screen.getByText('~/project')).toBeInTheDocument()
})

it.each([
  ['sandbox', 'Local sandbox'],
  ['cloud', 'Cloud'],
  ['computer', 'This computer'],
] as const)('shows a read-only %s environment', async (location, label) => {
  const execution =
    location === 'computer' ? { location, cwd: '/local', access: 'ask' as const } : { location, access: 'ask' as const }
  const project = await createProject(getDb(), { name: label, execution })
  render(<ProjectExecutionSummary projectId={project.id} />, { wrapper: createTestProvider() })
  await settle()
  expect(screen.getByLabelText('Project environment')).toHaveTextContent(label)
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})
