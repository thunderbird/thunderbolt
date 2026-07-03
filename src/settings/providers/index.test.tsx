/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createProvider } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase, testUserId, wsId } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import {
  renderWithReactivity,
  resetTestTrustDomain,
  seedTestTrustDomain,
  waitForElement,
} from '@/test-utils/powersync-reactivity-test'
import '@testing-library/jest-dom'
import { cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import ProvidersPage from './index'

describe('ProvidersPage', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    seedTestTrustDomain()
    await resetTestDatabase()
  })

  afterEach(() => {
    resetTestTrustDomain()
    cleanup()
  })

  it('lists a connected provider with its account label', async () => {
    const db = getDb()
    await createProvider(db, wsId, {
      id: uuidv7(),
      type: 'openrouter',
      label: 'me@example.com',
      enabledCapabilities: ['models'],
      userId: testUserId,
    })

    renderWithReactivity(<ProvidersPage />, { route: '/settings/providers', tables: ['providers'] })

    await waitForElement(() => screen.queryByText('me@example.com'))
    expect(screen.getByText('me@example.com')).toBeInTheDocument()
  })

  it('offers connect targets for unconnected types and marks coming-soon providers', async () => {
    renderWithReactivity(<ProvidersPage />, { route: '/settings/providers', tables: ['providers'] })

    await waitForElement(() => screen.queryByText('OpenAI'))
    expect(screen.getByText('OpenAI')).toBeInTheDocument()
    // Tinfoil is coming soon → its action button is disabled.
    expect(screen.getByRole('button', { name: 'Coming soon' })).toBeDisabled()
  })
})
