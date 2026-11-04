/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { useConfigStore } from '@/api/config-store'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { builtInAgent } from '@/defaults/agents'

import { CreateItemProvider, useCreateItem } from './context'
import { CreateItemHost } from './create-item-host'

const HostControls = () => {
  const { openCreateItem, closeCreateItem } = useCreateItem()
  return (
    <>
      <button type="button" onClick={() => openCreateItem({ kind: 'skill' })}>
        open skill
      </button>
      <button type="button" onClick={() => openCreateItem({ kind: 'agent', agentId: builtInAgent.id })}>
        edit agent
      </button>
      <button type="button" onClick={closeCreateItem}>
        close
      </button>
    </>
  )
}

const Wrapper = ({ children }: { children: ReactNode }) => {
  const Provider = createTestProvider()
  return (
    <Provider>
      <MemoryRouter>
        <CreateItemProvider>
          {children}
          <HostControls />
        </CreateItemProvider>
      </MemoryRouter>
    </Provider>
  )
}

describe('CreateItemHost', () => {
  beforeEach(() => useConfigStore.setState({ config: {}, configLoaded: true }))
  beforeAll(async () => {
    // Exercise panel routing independently of the lazy module's disk-loading time.
    await import('./create-agent-panel')
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    cleanup()
    await resetTestDatabase()
  })

  it('renders nothing until a create request arrives', () => {
    const { container } = render(<CreateItemHost />, { wrapper: Wrapper })
    expect(container.querySelector('[data-slot="slide-in-panel"]')).toBeNull()
  })

  it('opens the existing agent detail instead of the creation wizard', async () => {
    render(<CreateItemHost />, { wrapper: Wrapper })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'edit agent' }))
      await getClock().runAllAsync()
    })
    expect(screen.getByRole('heading', { name: builtInAgent.name })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Add Agent' })).toBeNull()
  })

  it('keeps the requested panel mounted through its close animation, then releases it', async () => {
    render(<CreateItemHost />, { wrapper: Wrapper })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'open skill' }))
      await getClock().runAllAsync()
    })
    expect(await screen.findByRole('heading', { name: 'Create Skill' })).toBeInTheDocument()

    // Closing keeps the last request mounted (hidden and inert) so the
    // surface can animate shut instead of vanishing.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'close' }))
      await getClock().runAllAsync()
    })
    expect(screen.getByText('Create Skill')).toBeInTheDocument()
    const closingPanel = document.querySelector('[data-slot="slide-in-panel"]')
    if (!closingPanel) {
      throw new Error('Closing create-item panel not found')
    }
    expect(closingPanel).toHaveAttribute('aria-hidden', 'true')

    fireEvent.transitionEnd(closingPanel, { propertyName: 'width' })
    expect(document.querySelector('[data-slot="slide-in-panel"]')).toBeNull()
  })
})
