/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DatabaseProvider } from '@/contexts/database-context'
import { PowerSyncMockProvider } from '@/test-utils/powersync-mock'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { createProject } from '@/dal/projects'
import { useAgentExecutionStore } from '@/agent-execution/store'
import { AgentExecutionControls } from './agent-execution-controls'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(cleanup)
beforeEach(() => useAgentExecutionStore.setState({ byProject: {}, byThread: {} }))

it('locks the project environment while changing access for every chat in that project only', async () => {
  const project = await createProject(getDb(), { name: 'Fixed environment' })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: PropsWithChildren) => (
    <DatabaseProvider db={getDb()}>
      <PowerSyncMockProvider>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      </PowerSyncMockProvider>
    </DatabaseProvider>
  )
  render(<AgentExecutionControls threadId="project-chat" projectId={project.id} disabled={false} />, { wrapper })
  await waitForElement(() => {
    const button = screen.queryByRole('button', { name: 'Agent location' })
    return button && !button.hasAttribute('disabled') ? button : null
  })
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent location' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  })
  expect(screen.queryByText('Set when this project was created')).toBeNull()
  expect(screen.getByText('Local sandbox').closest('[role="menuitem"]')).toHaveAttribute('aria-disabled', 'true')
  expect(screen.queryByText('Cloud')).toBeNull()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Agent access' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse',
  })
  fireEvent.click(screen.getByText('Full access'))
  expect(useAgentExecutionStore.getState().byProject[project.id]?.access).toBe('full')
  expect(useAgentExecutionStore.getState().byThread).toEqual({})
  client.clear()
})
