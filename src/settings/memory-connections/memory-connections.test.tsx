/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, mock, test } from 'bun:test'
import type { ReactNode } from 'react'
import { CreateItemProvider, useCreateItem } from '@/components/create-item/context'
import { createMcpServer } from '@/dal'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { MCPProvider, type MCPClient } from '@/lib/mcp-provider'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { MemoryConnections } from './memory-connections'
import { HttpClientProvider } from '@/contexts'
import { createMockHttpClient } from '@/test-utils/http-client'

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
afterEach(cleanup)

const noConnection = (): Promise<MCPClient> => new Promise(() => {})
const Wrapper = ({ children }: { children: ReactNode }) => (
  <CreateItemProvider>
    <HttpClientProvider httpClient={createMockHttpClient()}>
      <MCPProvider createClient={noConnection}>{children}</MCPProvider>
    </HttpClientProvider>
  </CreateItemProvider>
)
const Selection = () => {
  const { request } = useCreateItem()
  return <output aria-label="Selected connection">{JSON.stringify(request)}</output>
}

test('lists shared MCP records alongside built-in and allows choosing or managing a provider', async () => {
  await createMcpServer(getDb(), {
    id: 'memory-one',
    name: 'Shared work notes',
    url: 'https://mcp.supermemory.ai/mcp',
    type: 'http',
    enabled: 1,
  })
  await createMcpServer(getDb(), {
    id: 'unrelated',
    name: 'Mem0',
    url: 'https://unrelated.example/mcp',
    type: 'http',
    enabled: 1,
  })
  const select = mock(() => {})
  renderWithReactivity(
    <>
      <MemoryConnections
        selectedProvider="builtin"
        onSelect={select}
        builtinMemory={{
          content: 'Keep the saved preview',
          isLoading: false,
          compacting: false,
          canCompact: true,
          onView: mock(() => {}),
          onEdit: mock(() => {}),
          onCompact: mock(() => {}),
        }}
      />
      <Selection />
    </>,
    { tables: ['mcp_servers'], wrapper: Wrapper },
  )
  await waitForElement(() => screen.queryByText('Shared work notes'))
  expect(screen.getByText('Not connected')).toBeVisible()
  expect(screen.getByRole('radio', { name: 'Built-in' })).toBeChecked()
  fireEvent.click(screen.getByRole('radio', { name: 'Shared work notes' }))
  expect(select).toHaveBeenCalledWith('mcp:memory-one')
  expect(screen.queryByRole('button', { name: 'Manage Mem0' })).toBeNull()
  expect(screen.getByText('Shared work notes').closest('label')?.querySelector('img')?.getAttribute('src')).toContain(
    'supermemory',
  )
  expect(screen.queryByText('No connections yet.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Manage Shared work notes' }))
  expect(screen.getByLabelText('Selected connection')).toHaveTextContent('"mcpServerId":"memory-one"')
  const add = screen.getByRole('button', { name: 'Add connection' })
  expect(add).toBeEnabled()
  expect(add.textContent).toBe('')
  expect(add).toHaveAttribute('title', 'Add connection')
  fireEvent.click(add)
  expect(screen.getByLabelText('Selected connection')).toHaveTextContent('"memoryOnly":true')
})
