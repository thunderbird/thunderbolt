/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { AuthProvider, DatabaseProvider, HttpClientProvider, SignInModalProvider } from '@/contexts'
import { getDb } from '@/db/database'
import { chatThreadsTable, projectsTable } from '@/db/tables'
import { deleteChatThread } from '@/dal'
import { createProject } from '@/dal/projects'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { SidebarProvider } from '@/components/ui/sidebar'
import { createMockAuthClient } from '@/test-utils/auth-client'
import { createMockHttpClient } from '@/test-utils/http-client'
import { mockVirtuaMeasurement } from '@/test-utils/mock-virtua-measurement'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { v7 as uuidv7 } from 'uuid'
import Sidebar from './index'
import type { ReactNode } from 'react'

const createSidebarWrapper =
  ({ path = '/chats/new', defaultOpen = true } = {}) =>
  ({ children }: { children: ReactNode }) => (
    <DatabaseProvider db={getDb()}>
      <HttpClientProvider httpClient={createMockHttpClient([])}>
        <AuthProvider authClient={createMockAuthClient()}>
          <SignInModalProvider>
            <MemoryRouter initialEntries={[path]}>
              <SidebarProvider defaultOpen={defaultOpen}>
                <Routes>
                  <Route path="/*" element={children} />
                </Routes>
              </SidebarProvider>
            </MemoryRouter>
          </SignInModalProvider>
        </AuthProvider>
      </HttpClientProvider>
    </DatabaseProvider>
  )

const SidebarTestWrapper = createSidebarWrapper()
const SidebarLocationProbe = () => <output data-testid="sidebar-location">{useLocation().pathname}</output>

describe('Sidebar reactivity', () => {
  // The chat list is virtualized (virtua) — give it real-looking measurements
  // or it renders zero rows in happy-dom.
  let restoreVirtuaMeasurement: () => void

  beforeAll(async () => {
    restoreVirtuaMeasurement = mockVirtuaMeasurement()
    await setupTestDatabase()
  })

  afterAll(async () => {
    restoreVirtuaMeasurement()
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(() => {
    cleanup()
    restoreViewport()
  })

  it('updates when chat_threads table changes', async () => {
    const threadId1 = uuidv7()
    const threadId2 = uuidv7()
    const db = getDb()

    await db.insert(chatThreadsTable).values([
      { id: threadId1, title: 'First Chat', isEncrypted: 0 },
      { id: threadId2, title: 'Second Chat', isEncrypted: 0 },
    ])

    const { triggerChange } = renderWithReactivity(<Sidebar />, {
      tables: ['chat_threads'],
      wrapper: SidebarTestWrapper,
    })

    await waitForElement(() => screen.queryByText('First Chat'))
    expect(screen.getByText('First Chat')).toBeInTheDocument()
    expect(screen.getByText('Second Chat')).toBeInTheDocument()
    expect(screen.getByText('First Chat').closest('li')?.firstElementChild).toHaveClass('pb-1')

    await deleteChatThread(db, threadId2)
    triggerChange(['chat_threads'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('First Chat')).toBeInTheDocument()
    expect(screen.queryByText('Second Chat')).not.toBeInTheDocument()
  })

  it.each([false, true])('uses one mobile navigation scroller (minimal mode: %s)', async (minimalMode) => {
    forceMobileViewport()
    useConfigStore.setState({ config: { minimalMode }, configLoaded: true })
    await getDb().insert(chatThreadsTable).values({ id: uuidv7(), title: 'Mobile Chat', isEncrypted: 0 })
    renderWithReactivity(<Sidebar />, { tables: ['chat_threads'], wrapper: SidebarTestWrapper })
    await waitForElement(() => screen.queryByText('Mobile Chat'))

    const scrollArea = document.querySelector<HTMLElement>('[data-slot="sidebar-navigation-scroll"]')
    expect(scrollArea).toContainElement(screen.getByText('Mobile Chat'))
    expect(scrollArea).toContainElement(screen.getByRole('button', { name: 'Recents' }))
    expect(scrollArea).toContainElement(document.querySelector('[data-slot="mobile-sidebar-header"]'))
    expect(scrollArea).not.toContainElement(document.querySelector('[data-sidebar="footer"]'))
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument()
  })

  describe('section toggle', () => {
    const minimalConfig = { config: { minimalMode: true }, configLoaded: true }

    beforeEach(() => {
      useConfigStore.setState({ config: {}, configLoaded: false })
    })

    afterEach(() => {
      useConfigStore.setState({ config: {}, configLoaded: false })
    })

    it('keeps chats visible until their live projects arrive through sync', async () => {
      useConfigStore.setState({ config: { minimalMode: false }, configLoaded: true })
      const projectId = uuidv7()
      await getDb()
        .insert(chatThreadsTable)
        .values({ id: uuidv7(), title: 'Waiting for project', projectId, isEncrypted: 0 })
      const { triggerChange } = renderWithReactivity(<Sidebar />, {
        tables: ['chat_threads', 'projects'],
        wrapper: SidebarTestWrapper,
      })
      expect(screen.queryByText('Waiting for project')).toBeNull()
      await waitForElement(() => screen.queryByText('Waiting for project'))
      expect(screen.queryByText('Waiting for project')).not.toBeNull()
      await getDb().insert(projectsTable).values({ id: projectId, name: 'Synced project' })
      await act(async () => {
        triggerChange(['projects'])
        await getClock().runAllAsync()
      })
      await waitForElement(() => screen.queryByText('Synced project'))
      expect(screen.queryByText('Waiting for project')).toBeNull()
    })

    it('offers the Settings section by default', () => {
      useConfigStore.setState({ config: { minimalMode: false }, configLoaded: true })
      renderWithReactivity(<Sidebar />, { tables: ['chat_threads'], wrapper: SidebarTestWrapper })

      expect(screen.getByLabelText('Settings')).toBeInTheDocument()
    })

    it.each([false, true])('opens the independent artifact library from the sidebar (mobile %s)', async (mobile) => {
      if (mobile) {
        forceMobileViewport()
      }
      useConfigStore.setState({ config: {}, configLoaded: true })
      renderWithReactivity(
        <>
          <Sidebar />
          <SidebarLocationProbe />
        </>,
        {
          tables: ['chat_threads'],
          wrapper: SidebarTestWrapper,
        },
      )
      const item = screen.getByRole('button', { name: 'Artifacts' })
      fireEvent.click(item)
      await act(async () => {
        await getClock().runAllAsync()
      })
      expect(screen.getByTestId('sidebar-location')).toHaveTextContent('/artifacts')
    })

    it('offers Projects outside minimal mode and hides it in minimal mode', async () => {
      useConfigStore.setState({ config: {}, configLoaded: true })
      renderWithReactivity(<Sidebar />, { tables: ['chat_threads'], wrapper: SidebarTestWrapper })
      expect(await waitForElement(() => screen.queryByText('Projects'))).toBeInTheDocument()

      cleanup()
      useConfigStore.setState(minimalConfig)
      renderWithReactivity(<Sidebar />, { tables: ['chat_threads'], wrapper: SidebarTestWrapper })
      expect(screen.queryByText('Projects')).not.toBeInTheDocument()
    })

    describe('with a project', () => {
      const renderWithProject = async (state: { config: { minimalMode?: boolean }; configLoaded: boolean }) => {
        await createProject(getDb(), { name: 'Alpha' })
        useConfigStore.setState(state)
        renderWithReactivity(<Sidebar />, { tables: ['chat_threads', 'projects'], wrapper: SidebarTestWrapper })
      }

      it('lists the project drop targets outside minimal mode', async () => {
        await renderWithProject({ config: {}, configLoaded: true })

        expect(await waitForElement(() => screen.queryByText('Projects'))).toBeInTheDocument()
      })

      it('hides the project drop targets in minimal mode', async () => {
        await renderWithProject(minimalConfig)
        await act(async () => {
          await getClock().runAllAsync()
        })

        expect(screen.queryByText('Projects')).not.toBeInTheDocument()
        expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
      })

      it('hides Projects and its drop targets until the config has loaded', async () => {
        await renderWithProject({ config: {}, configLoaded: false })
        await act(async () => {
          await getClock().runAllAsync()
        })

        expect(screen.queryByText('Projects')).not.toBeInTheDocument()
      })
    })

    it.each([false, true])(
      'renders from a persisted config before the fetch answers (minimal mode %s)',
      async (minimal) => {
        useConfigStore.setState({ config: { minimalMode: minimal }, configLoaded: false })
        renderWithReactivity(<Sidebar />, { tables: ['chat_threads'], wrapper: SidebarTestWrapper })

        expect(screen.queryByLabelText('Settings') !== null).toBe(!minimal)
        if (!minimal) {
          await waitForElement(() => screen.queryByText('Projects'))
        }
        expect(screen.queryByText('Projects') !== null).toBe(!minimal)
      },
    )

    it('shows the toggle once the first-ever fetch answers', () => {
      renderWithReactivity(<Sidebar />, { tables: ['chat_threads'], wrapper: SidebarTestWrapper })
      expect(screen.queryByLabelText('Settings')).not.toBeInTheDocument()

      act(() => useConfigStore.getState().updateConfig({ minimalMode: false }))

      expect(screen.getByLabelText('Settings')).toBeInTheDocument()
    })

    it('shows no section toggle until the config has loaded', () => {
      renderWithReactivity(<Sidebar />, { tables: ['chat_threads'], wrapper: SidebarTestWrapper })

      expect(screen.queryByLabelText('Settings')).not.toBeInTheDocument()
    })

    it('leaves the toggle slot empty in minimal mode', () => {
      useConfigStore.setState(minimalConfig)
      renderWithReactivity(<Sidebar />, { tables: ['chat_threads'], wrapper: SidebarTestWrapper })

      expect(screen.queryByLabelText('Settings')).not.toBeInTheDocument()
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    })

    it('leaves the collapsed rail without a toggle in minimal mode', () => {
      useConfigStore.setState(minimalConfig)
      renderWithReactivity(<Sidebar />, {
        tables: ['chat_threads'],
        wrapper: createSidebarWrapper({ defaultOpen: false }),
      })

      expect(screen.queryByLabelText('Settings')).not.toBeInTheDocument()
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    })

    it('leaves the mobile header without a toggle in minimal mode', () => {
      forceMobileViewport()
      useConfigStore.setState(minimalConfig)
      renderWithReactivity(<Sidebar />, { tables: ['chat_threads'], wrapper: SidebarTestWrapper })

      const mobileHeader = document.querySelector<HTMLElement>('[data-slot="mobile-sidebar-header"]')
      expect(mobileHeader).toBeInTheDocument()
      expect(screen.queryByLabelText('Settings')).not.toBeInTheDocument()
      expect(mobileHeader).toContainElement(screen.getByRole('button', { name: 'Search' }))
    })

    it('pulls an open Settings section back to chats when minimal mode arrives', () => {
      renderWithReactivity(<Sidebar />, {
        tables: ['chat_threads'],
        wrapper: createSidebarWrapper({ path: '/settings/models' }),
      })
      expect(screen.getByText('Preferences')).toBeInTheDocument()

      act(() => useConfigStore.getState().updateConfig({ minimalMode: true }))

      expect(screen.queryByText('Preferences')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Chats')).not.toBeInTheDocument()
    })

    it('keeps the Settings section open when the loaded config is not minimal', () => {
      renderWithReactivity(<Sidebar />, {
        tables: ['chat_threads'],
        wrapper: createSidebarWrapper({ path: '/settings/models' }),
      })

      act(() => useConfigStore.getState().updateConfig({ minimalMode: false }))

      // Settings-only navigation, absent from the chats sidebar.
      expect(screen.getByText('Preferences')).toBeInTheDocument()
    })
  })
})
