/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AuthClient } from '@/contexts'
import { SignInModalProvider } from '@/contexts'
import { SidebarProvider } from '@/components/ui/sidebar'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createTestProvider } from '@/test-utils/test-provider'
import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import { SettingsSidebarContent } from './settings-sidebar'

const anonSession = {
  user: { id: 'anon-1', email: '', name: '', isAnonymous: true },
}

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

const renderSidebar = (authClient: AuthClient, isStandalone: () => boolean) => {
  const TestProvider = createTestProvider({ authClient })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <TestProvider>
      <SignInModalProvider>
        <MemoryRouter initialEntries={['/settings']}>
          <SidebarProvider>{children}</SidebarProvider>
        </MemoryRouter>
      </SignInModalProvider>
    </TestProvider>
  )
  return render(
    <SettingsSidebarContent onBackClick={() => {}} onSettingsNavigate={() => {}} isStandalone={isStandalone} />,
    { wrapper: Wrapper },
  )
}

const onTauri = () => true
const offTauri = () => false

describe('SettingsSidebarContent — Agents entry visibility', () => {
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

  it('hides the Agents entry for anonymous users when the proxy is effectively on (web)', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderSidebar(authClient, offTauri)

    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
  })

  it('hides the Agents entry for anonymous users on Tauri Connected (proxy_enabled=true)', () => {
    localStorage.setItem('proxy_enabled', 'true')
    const authClient = createMockAuthClient({ session: anonSession })
    renderSidebar(authClient, onTauri)

    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
  })

  it('shows the Agents entry for anonymous users on Tauri Standalone (proxy off)', () => {
    // localStorage has no `proxy_enabled` — defaults to false on Tauri.
    const authClient = createMockAuthClient({ session: anonSession })
    renderSidebar(authClient, onTauri)

    expect(screen.getByText('Agents')).toBeInTheDocument()
  })

  it('shows the Agents entry for authenticated users behind the proxy (web)', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderSidebar(authClient, offTauri)

    expect(screen.getByText('Agents')).toBeInTheDocument()
  })

  it('shows the Agents entry for authenticated users on Tauri Standalone (proxy off)', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderSidebar(authClient, onTauri)

    expect(screen.getByText('Agents')).toBeInTheDocument()
  })
})
