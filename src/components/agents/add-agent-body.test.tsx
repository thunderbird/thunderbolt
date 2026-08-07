/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore, type AppConfig } from '@/api/config-store'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { AddAgentBody } from './add-agent-body'

const authedSession = { user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false } }

const catalogWith = (descriptors: unknown[]) => ({ version: '1', descriptors })

const haystackDescriptor = {
  id: 'haystack',
  provider: 'haystack',
  name: 'Haystack RAG agent',
  description: null,
  icon: null,
  schemaVersion: 1,
  action: 'deploy',
  steps: [{ id: 'basics', title: 'Basics', fields: [{ key: 'name', label: 'Name', widget: 'text' }] }],
}

const renderBody = (mockResponse?: unknown) => {
  const TestProvider = createTestProvider({
    authClient: createMockAuthClient({ session: authedSession }),
    mockResponse,
  })
  return render(<AddAgentBody onClose={() => {}} />, {
    wrapper: ({ children }: { children: ReactNode }) => <TestProvider>{children}</TestProvider>,
  })
}

describe('AddAgentBody', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    localStorage.clear()
    useConfigStore.getState().updateConfig({} as AppConfig)
  })

  const setConfig = (config: AppConfig) => {
    act(() => useConfigStore.getState().updateConfig(config))
  }

  it('renders the connect-only form when managed deploy is disabled', () => {
    setConfig({ allowCustomAgents: true })
    renderBody()

    expect(screen.getByPlaceholderText('My Agent')).toBeInTheDocument()
    expect(screen.queryByText('Connect custom agent')).not.toBeInTheDocument()
  })

  it('renders the catalog + connect list when managed deploy is enabled', async () => {
    setConfig({ agentDeploy: true, allowCustomAgents: true })
    renderBody(catalogWith([haystackDescriptor]))

    expect(await waitForElement(() => screen.queryByText('Connect custom agent'))).toBeInTheDocument()
    expect(screen.getByText('Haystack RAG agent')).toBeInTheDocument()
  })
})
