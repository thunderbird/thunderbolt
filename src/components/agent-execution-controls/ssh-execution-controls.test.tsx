/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, mock, spyOn } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import * as tauri from '@tauri-apps/api/core'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DatabaseProvider } from '@/contexts/database-context'
import { PowerSyncMockProvider } from '@/test-utils/powersync-mock'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createProject } from '@/dal/projects'
import * as platform from '@/lib/platform'
import * as statusHook from '@/agent-execution/use-ssh-environment-status'
import { useSshEnvironmentsStore, type SshEnvironment } from '@/agent-execution/ssh-environments'
import { useAgentExecutionStore } from '@/agent-execution/store'
import { AgentExecutionControls } from './agent-execution-controls'
import { ProjectExecutionField } from '@/projects/project-execution-field'

const environment: SshEnvironment = {
  id: 'edfa69dd-fe35-4bbe-a745-026769cbb913',
  name: 'My OrbStack',
  host: 'orb',
  cwd: '~/work',
  authentication: 'agent',
  deletedAt: null,
}
const second: SshEnvironment = { ...environment, id: 'f8be6af5-d3b2-449b-8e1f-d1701d832534', name: 'Other machine' }
const openLocation = () =>
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent location' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  })
beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(() => {
  useSshEnvironmentsStore.setState({ environments: {} })
  useAgentExecutionStore.setState({ byThread: {}, byProject: {} })
  spyOn(platform, 'isTauriDesktop').mockReturnValue(true)
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({ status: 'connected', error: null, refresh: mock() })
})
afterEach(() => {
  cleanup()
  useSshEnvironmentsStore.setState({ environments: {} })
  useAgentExecutionStore.setState({ byThread: {}, byProject: {} })
  mock.restore()
})

it('selects an SSH environment for only the current standalone chat and shows its status', () => {
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  render(
    <MemoryRouter>
      <AgentExecutionControls threadId="ssh-chat" disabled={false} />
    </MemoryRouter>,
  )
  openLocation()
  fireEvent.click(screen.getByText('My OrbStack'))
  expect(useAgentExecutionStore.getState().byThread['ssh-chat']).toEqual({
    location: 'ssh',
    environmentId: environment.id,
    cwd: environment.cwd,
    access: 'ask',
  })
  expect(useAgentExecutionStore.getState().byThread['other']).toBeUndefined()
  expect(screen.getByRole('button', { name: 'Agent location' })).toHaveAttribute('title', 'My OrbStack')
  expect(screen.getByRole('status', { name: 'Connected' })).toBeInTheDocument()
})

it('offers configured SSH environments when creating a project and excludes deleted ones', () => {
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  useSshEnvironmentsStore.getState().saveEnvironment(second)
  useSshEnvironmentsStore.getState().deleteEnvironment(second.id)
  const onChange = mock()
  render(
    <MemoryRouter>
      <ProjectExecutionField execution={{ location: 'sandbox', access: 'ask' }} onChange={onChange} disabled={false} />
    </MemoryRouter>,
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Project environment' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  })
  expect(screen.queryByText('Other machine')).toBeNull()
  fireEvent.click(screen.getByText('My OrbStack'))
  expect(onChange).toHaveBeenCalledWith({
    location: 'ssh',
    environmentId: environment.id,
    cwd: environment.cwd,
    access: 'ask',
  })
})

it('keeps a project locked to its SSH environment while changing only access', async () => {
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  useSshEnvironmentsStore.getState().saveEnvironment(second)
  const project = await createProject(getDb(), {
    name: 'SSH project',
    execution: { location: 'ssh', environmentId: environment.id, cwd: environment.cwd, access: 'ask' },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <DatabaseProvider db={getDb()}>
        <PowerSyncMockProvider>
          <QueryClientProvider client={client}>
            <AgentExecutionControls threadId="project-chat" projectId={project.id} disabled={false} />
          </QueryClientProvider>
        </PowerSyncMockProvider>
      </DatabaseProvider>
    </MemoryRouter>,
  )
  await waitForElement(() => {
    const button = screen.queryByRole('button', { name: 'Agent location' })
    return button && !button.hasAttribute('disabled') ? button : null
  })
  openLocation()
  expect(screen.getByText('My OrbStack').closest('[role="menuitem"]')).toHaveAttribute('aria-disabled', 'true')
  expect(screen.queryByText('Set when this project was created')).toBeNull()
  expect(screen.queryByText('Other machine')).toBeNull()
  expect(screen.queryByText('This computer')).toBeNull()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent access' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  })
  fireEvent.click(screen.getByText('Full access'))
  expect(useAgentExecutionStore.getState().byProject[project.id]).toEqual({
    location: 'ssh',
    environmentId: environment.id,
    cwd: environment.cwd,
    access: 'full',
  })
  client.clear()
})

it('does not expose desktop SSH choices on web', () => {
  spyOn(platform, 'isTauriDesktop').mockReturnValue(false)
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  render(
    <MemoryRouter>
      <AgentExecutionControls threadId="web-chat" disabled={false} />
    </MemoryRouter>,
  )
  openLocation()
  expect(screen.queryByText('My OrbStack')).toBeNull()
  expect(screen.queryByText('Manage SSH environments')).toBeNull()
})

it('uses the unavailable indicator without a repeated composer message for a removed project environment', async () => {
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  const project = await createProject(getDb(), {
    name: 'Removed SSH environment',
    execution: { location: 'ssh', environmentId: environment.id, cwd: environment.cwd, access: 'ask' },
  })
  useSshEnvironmentsStore.getState().deleteEnvironment(environment.id)
  spyOn(statusHook, 'useSshEnvironmentStatus').mockReturnValue({
    status: 'unavailable',
    error: 'This SSH environment is unavailable on this computer.',
    refresh: mock(),
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <MemoryRouter>
      <DatabaseProvider db={getDb()}>
        <PowerSyncMockProvider>
          <QueryClientProvider client={client}>
            <AgentExecutionControls threadId="removed-ssh-chat" projectId={project.id} disabled={false} />
          </QueryClientProvider>
        </PowerSyncMockProvider>
      </DatabaseProvider>
    </MemoryRouter>,
  )
  await waitForElement(() => screen.queryByRole('status', { name: 'SSH environment unavailable' }))
  expect(screen.getByRole('button', { name: 'Agent access' })).toBeDisabled()
  expect(screen.queryByText("This project's SSH environment is unavailable on this computer.")).toBeNull()
  client.clear()
})

it('dismisses the project creator before navigating to manage SSH environments', () => {
  const onManage = mock()
  render(
    <MemoryRouter>
      <ProjectExecutionField
        execution={{ location: 'sandbox', access: 'ask' }}
        onChange={mock()}
        disabled={false}
        onManageEnvironments={onManage}
      />
    </MemoryRouter>,
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Project environment' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  })
  fireEvent.click(screen.getByText('Manage SSH environments'))
  expect(onManage).toHaveBeenCalledTimes(1)
})

it('gives each SSH project its own remote folder without opening the local picker or changing hosts', () => {
  useSshEnvironmentsStore.getState().saveEnvironment(environment)
  const invoke = spyOn(tauri, 'invoke').mockClear().mockResolvedValue(undefined)
  const onChange = mock()
  const execution = { location: 'ssh', environmentId: environment.id, cwd: environment.cwd, access: 'ask' } as const
  render(
    <MemoryRouter>
      <ProjectExecutionField execution={execution} onChange={onChange} disabled={false} />
    </MemoryRouter>,
  )
  expect(screen.getByLabelText('Remote working folder')).toHaveValue(environment.cwd)
  fireEvent.change(screen.getByLabelText('Remote working folder'), { target: { value: '~/projects/my-app' } })
  expect(onChange).toHaveBeenCalledWith({ ...execution, cwd: '~/projects/my-app' })
  expect(useSshEnvironmentsStore.getState().environments[environment.id].cwd).toBe(environment.cwd)
  expect(invoke).not.toHaveBeenCalled()
})
