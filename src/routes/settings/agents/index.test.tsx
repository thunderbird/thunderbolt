/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import AgentsSettingsPage from './index'

const anonSession = {
  user: { id: 'anon-1', email: '', name: '', isAnonymous: true },
}

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

const settingsIndexMarker = 'settings-index-marker'

const fakeUseWorkspacePermission = (isAllowed: boolean) =>
  (() => ({
    requiredRole: 'admin' as const,
    isAllowed,
    isResolved: true,
  })) as unknown as typeof import('@/hooks/use-workspace-permission').useWorkspacePermission

const renderPage = (
  authClient: AuthClient,
  isStandalone: () => boolean,
  opts: { useWorkspacePermission?: ReturnType<typeof fakeUseWorkspacePermission> } = {},
) => {
  const TestProvider = createTestProvider({ authClient })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <MemoryRouter initialEntries={['/settings/agents']}>
        <Routes>
          <Route path="/settings/agents" element={children} />
          <Route path="/settings" element={<div data-testid={settingsIndexMarker} />} />
        </Routes>
      </MemoryRouter>
    </TestProvider>
  )
  return render(
    <AgentsSettingsPage isStandalone={isStandalone} useWorkspacePermission={opts.useWorkspacePermission} />,
    { wrapper: Wrapper },
  )
}

const onTauri = () => true
const offTauri = () => false

describe('AgentsSettingsPage — hidden state guard', () => {
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

  it('redirects to /settings for anonymous users when the proxy is effectively on (web)', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient, offTauri)

    expect(screen.getByTestId(settingsIndexMarker)).toBeInTheDocument()
    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
  })

  it('redirects for anonymous users on Tauri Connected (proxy_enabled=true)', () => {
    localStorage.setItem('proxy_enabled', 'true')
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient, onTauri)

    expect(screen.getByTestId(settingsIndexMarker)).toBeInTheDocument()
  })

  it('renders the page for anonymous users on Tauri Standalone (proxy off)', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderPage(authClient, onTauri)

    expect(screen.queryByTestId(settingsIndexMarker)).not.toBeInTheDocument()
    // Header is the stable rendered-marker; the Add affordance is workspace
    // permission-gated and not seeded in these "hidden state guard" tests.
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument()
  })

  it('renders the page for authenticated users behind the proxy (web)', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient, offTauri)

    expect(screen.queryByTestId(settingsIndexMarker)).not.toBeInTheDocument()
    // Header is the stable rendered-marker; the Add affordance is workspace
    // permission-gated and not seeded in these "hidden state guard" tests.
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument()
  })

  it('renders the page for authenticated users on Tauri Standalone', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient, onTauri)

    expect(screen.queryByTestId(settingsIndexMarker)).not.toBeInTheDocument()
    // Header is the stable rendered-marker; the Add affordance is workspace
    // permission-gated and not seeded in these "hidden state guard" tests.
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument()
  })
})

describe('AgentsSettingsPage — permission gating (add_agents)', () => {
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

  it('renders the "Add Custom Agent" button when the user has add_agents', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient, onTauri, { useWorkspacePermission: fakeUseWorkspacePermission(true) })

    expect(screen.getByRole('button', { name: /add custom agent/i })).toBeInTheDocument()
  })

  it('hides the "Add Custom Agent" button when the user lacks add_agents', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderPage(authClient, onTauri, { useWorkspacePermission: fakeUseWorkspacePermission(false) })

    expect(screen.getByRole('heading', { name: 'Agents' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add custom agent/i })).not.toBeInTheDocument()
  })
})
