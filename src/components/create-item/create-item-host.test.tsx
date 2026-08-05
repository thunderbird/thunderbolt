/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { getClock } from '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import type { ReactNode } from 'react'

import { CreateItemProvider, useCreateItem } from './context'
import { CreateItemHost } from './create-item-host'

const HostControls = () => {
  const { openCreateItem, closeCreateItem } = useCreateItem()
  return (
    <>
      <button type="button" onClick={() => openCreateItem({ kind: 'skill' })}>
        open skill
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
      <CreateItemProvider>
        {children}
        <HostControls />
      </CreateItemProvider>
    </Provider>
  )
}

describe('CreateItemHost', () => {
  beforeAll(async () => {
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
