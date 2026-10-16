/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'

import { useConfigStore } from '@/api/config-store'
import { CreateItemProvider } from '@/components/create-item/context'
import { SidebarProvider } from '@/components/ui/sidebar'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import SettingsLayout from './layout'

const LocationProbe = () => <output data-testid="location">{useLocation().pathname}</output>

const renderAt = (path: string) => {
  const TestProvider = createTestProvider()
  return render(
    <TestProvider>
      <SidebarProvider>
        <CreateItemProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path="/chats/new" element={<LocationProbe />} />
              <Route path="/settings" element={<SettingsLayout />}>
                <Route path="models" element={<div>Models page</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </CreateItemProvider>
      </SidebarProvider>
    </TestProvider>,
  )
}

describe('SettingsLayout', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  afterEach(() => {
    cleanup()
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  it('renders the settings pages by default', () => {
    renderAt('/settings/models')

    expect(screen.getByText('Models page')).toBeInTheDocument()
  })

  it('sends a deep link back to the chat home in minimal mode', () => {
    useConfigStore.setState({ config: { minimalMode: true } })
    renderAt('/settings/models')

    expect(screen.getByTestId('location')).toHaveTextContent('/chats/new')
    expect(screen.queryByText('Models page')).not.toBeInTheDocument()
  })
})
