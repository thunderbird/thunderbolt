/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { cleanup, renderHook } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'

import { useConfigStore } from '@/api/config-store'
import { SidebarProvider } from '@/components/ui/sidebar'
import { setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { useCommands } from './use-commands'

const TestProvider = createTestProvider()
const Wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <TestProvider>
      <SidebarProvider>{children}</SidebarProvider>
    </TestProvider>
  </MemoryRouter>
)

const renderCommands = () =>
  renderHook(() => useCommands({ onSignOut: () => {}, onClearAllChats: () => {} }), { wrapper: Wrapper })

const settingsCommandIds = (commands: ReturnType<typeof useCommands>) =>
  commands.filter((command) => 'to' in command && command.to.startsWith('/settings/')).map((command) => command.id)

/** Wires the real hook to the config store, which `buildCommands` tests bypass. */
describe('useCommands config wiring', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(() => {
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  afterEach(() => {
    cleanup()
    useConfigStore.setState({ config: {}, configLoaded: false })
  })

  it('offers Settings commands by default', () => {
    const { result } = renderCommands()

    expect(settingsCommandIds(result.current)).toEqual(expect.arrayContaining(['agents', 'models', 'preferences']))
  })

  it('drops every Settings command in minimal mode', () => {
    useConfigStore.setState({ config: { minimalMode: true }, configLoaded: true })
    const { result } = renderCommands()

    expect(settingsCommandIds(result.current)).toEqual([])
    expect(result.current.map((command) => command.id)).not.toContain('create-model')
  })
})
