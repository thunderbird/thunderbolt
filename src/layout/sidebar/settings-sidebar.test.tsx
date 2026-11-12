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
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { MemoryRouter } from 'react-router'
import type { ReactNode } from 'react'
import {
  RecoveryContinuityContext,
  type RecoveryContinuityContextValue,
} from '@/components/recovery-continuity/recovery-continuity-provider'
import { SettingsSidebarContent } from './settings-sidebar'

const anonSession = {
  user: { id: 'anon-1', email: '', name: '', isAnonymous: true },
}

const authedSession = {
  user: { id: 'user-1', email: 'a@b.com', name: 'Alice', isAnonymous: false },
}

const renderSidebar = (authClient: AuthClient, onSearchClick = () => {}) => {
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
    <SettingsSidebarContent
      isCollapsed={false}
      onSectionChange={() => {}}
      onSettingsNavigate={() => {}}
      onSearchClick={onSearchClick}
    />,
    {
      wrapper: Wrapper,
    },
  )
}

const attentionContext: RecoveryContinuityContextValue = {
  status: 'warning',
  phraseUpdateRequired: true,
  passkey: 'none',
  notice: 'none',
  deviceTrusted: true,
  passkeyMigration: { busy: false, errorMessage: null },
  start: async () => {},
  startPasskeyMigration: async () => {},
  dismissNotice: () => {},
}

describe('SettingsSidebarContent — continuity attention', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('marks Preferences and links to the status card', () => {
    const onSettingsNavigate = mock((_path: string) => {})
    const TestProvider = createTestProvider({ authClient: createMockAuthClient({ session: authedSession }) })
    render(
      <TestProvider>
        <SignInModalProvider>
          <MemoryRouter initialEntries={['/settings']}>
            <SidebarProvider>
              <RecoveryContinuityContext.Provider value={attentionContext}>
                <SettingsSidebarContent
                  isCollapsed={false}
                  onSectionChange={() => {}}
                  onSettingsNavigate={onSettingsNavigate}
                />
              </RecoveryContinuityContext.Provider>
            </SidebarProvider>
          </MemoryRouter>
        </SignInModalProvider>
      </TestProvider>,
    )

    const preferences = screen.getByRole('button', { name: /^Preferences.*Action needed/ })
    fireEvent.click(preferences)
    expect(onSettingsNavigate).toHaveBeenCalledWith('/settings/preferences#recovery-phrase-status')
  })
})

// The Agents entry is unconditional: the built-in agent is local-first and
// custom ACP agents (including proxy-free iroh targets) work without a real
// account, so no session or proxy state hides it.
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

  it('shows the Agents entry for anonymous users', () => {
    const authClient = createMockAuthClient({ session: anonSession })
    renderSidebar(authClient)

    expect(screen.getByText('All agents')).toBeInTheDocument()
  })

  it('shows the Agents entry for authenticated users', () => {
    const authClient = createMockAuthClient({ session: authedSession })
    renderSidebar(authClient)

    expect(screen.getByText('All agents')).toBeInTheDocument()
  })

  it('keeps global search available alongside the Settings tab', () => {
    const onSearchClick = mock()
    renderSidebar(createMockAuthClient({ session: anonSession }), onSearchClick)
    fireEvent.click(screen.getByLabelText('Search', { selector: 'button' }))
    expect(onSearchClick).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page')
  })
})
