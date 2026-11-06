/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { createAgent } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import type { EntityActionIntent } from '@/search/actions/types'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import { waitForElement } from '@/test-utils/powersync-reactivity-test'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import AgentsSettingsPage from './index'

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

// A palette action intent is delivered to the page via router `location.state`
// under the `agentsAction` key (see search/actions/entity-actions.ts). Mount the
// page with that state and assert the existing panel handler fired.
const renderWithIntent = (authClient: AuthClient, intent: EntityActionIntent) => {
  const TestProvider = createTestProvider({ authClient })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <MemoryRouter
        initialEntries={[{ pathname: '/settings/agents', state: { agentsAction: JSON.stringify(intent) } }]}
      >
        {children}
      </MemoryRouter>
    </TestProvider>
  )
  return render(<AgentsSettingsPage />, { wrapper: Wrapper })
}

describe('AgentsSettingsPage palette action intents', () => {
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
  })

  it('opens the Add Agent panel for a create intent', async () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderWithIntent(authClient, { type: 'create' })

    await waitForElement(() => screen.queryByRole('heading', { name: 'Add Agent' }))
    expect(screen.getByRole('heading', { name: 'Add Agent' })).toBeInTheDocument()
  })

  it('opens the detail panel for an edit intent targeting a custom agent', async () => {
    const db = getDb()
    await createAgent(db, {
      id: 'editable-agent',
      name: 'My Custom Agent',
      type: 'remote-acp',
      transport: 'websocket',
      url: 'wss://example.com/acp',
      description: null,
      enabled: 1,
      userId: authedSession.user.id,
    })
    const authClient = createMockAuthClient({ session: authedSession })

    renderWithIntent(authClient, { type: 'edit', id: 'editable-agent' })

    await waitForElement(() => screen.queryByLabelText('Name'))
    expect(screen.getByLabelText('Name')).toHaveValue('My Custom Agent')
  })
})
