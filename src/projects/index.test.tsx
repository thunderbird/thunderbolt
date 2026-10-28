/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'

import { useConfigStore } from '@/api/config-store'
import { CreateItemProvider } from '@/components/create-item/context'
import { SidebarProvider } from '@/components/ui/sidebar'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import ProjectsPage from './index'

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
              <Route path="/projects" element={<ProjectsPage />} />
              <Route path="/projects/:projectId" element={<ProjectsPage />} />
            </Routes>
          </MemoryRouter>
        </CreateItemProvider>
      </SidebarProvider>
    </TestProvider>,
  )
}

describe('ProjectsPage in minimal mode', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(() => {
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  afterEach(() => {
    cleanup()
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  it('renders the projects list outside minimal mode', () => {
    renderAt('/projects')

    expect(screen.queryByTestId('location')).not.toBeInTheDocument()
  })

  it.each(['/projects', '/projects/abc'])('sends %s back to the chat home', (path) => {
    useConfigStore.setState({ config: { minimalMode: true }, configLoaded: true })
    renderAt(path)

    expect(screen.getByTestId('location')).toHaveTextContent('/chats/new')
  })
})
