/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createModel, saveIntegrationCredentials } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import ModelsPage from './index'

// ModelsPage uses react-router (useNavigate) for the "Connect/Enable Tinfoil"
// affordance, so renders go through renderWithReactivity's `route` option.
const renderModelsPage = () => renderWithReactivity(<ModelsPage />, { route: '/settings/models', tables: ['models'] })

const seedTinfoil = (enabled: boolean) =>
  saveIntegrationCredentials(
    getDb(),
    'tinfoil',
    {
      access_token: 'test-access',
      refresh_token: 'test-refresh',
      expires_at: Date.now() + 3_600_000,
      profile: { email: 'user@tinfoil.test', name: 'Tinfoil User' },
    },
    enabled,
  )

describe('ModelsPage reactivity', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
  })

  afterEach(() => {
    cleanup()
  })

  it('updates when models table changes', async () => {
    const db = getDb()
    const modelId1 = uuidv7()
    await createModel(db, {
      id: modelId1,
      provider: 'openai',
      name: 'First Model',
      model: 'gpt-4',
      isSystem: 0,
      enabled: 1,
    })

    const { triggerChange } = renderModelsPage()

    await waitForElement(() => screen.queryByText('First Model'))
    expect(screen.getByText('First Model')).toBeInTheDocument()

    const modelId2 = uuidv7()
    await createModel(db, {
      id: modelId2,
      provider: 'anthropic',
      name: 'Second Model',
      model: 'claude-3',
      isSystem: 0,
      enabled: 1,
    })
    triggerChange(['models'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('Second Model')).toBeInTheDocument()
  })
})

describe('ModelsPage — Tinfoil plan affordance', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    await resetTestDatabase()
    // Seed the default system models — includes the tinfoil-provider models
    // (DeepSeek V4 Pro, Kimi K2.6, GLM 5.1), all enabled by default.
    await reconcileDefaults(getDb())
  })

  afterEach(() => {
    cleanup()
  })

  it('shows the plan-active line when Tinfoil is connected and enabled', async () => {
    await seedTinfoil(true)
    renderModelsPage()

    await waitForElement(() => screen.queryByText('DeepSeek V4 Pro'))

    expect(screen.getAllByText(/powered by your connected tinfoil plan/i).length).toBeGreaterThan(0)
    // Active plan → no upsell affordance.
    expect(screen.queryByRole('button', { name: /connect tinfoil/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /enable tinfoil/i })).not.toBeInTheDocument()
  })

  it('prompts to Connect when Tinfoil is not connected (managed fallback)', async () => {
    renderModelsPage()

    await waitForElement(() => screen.queryByText('DeepSeek V4 Pro'))

    expect(screen.getAllByText(/runs on the managed tinfoil service/i).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /connect tinfoil/i }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /enable tinfoil/i })).not.toBeInTheDocument()
  })

  it('prompts to Enable (not Connect) when connected but the integration is disabled', async () => {
    await seedTinfoil(false)
    renderModelsPage()

    await waitForElement(() => screen.queryByText('DeepSeek V4 Pro'))

    // Connected-but-disabled still uses the managed path — mirrors ai/fetch.ts.
    expect(screen.getAllByText(/runs on the managed tinfoil service/i).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /enable tinfoil/i }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /connect tinfoil/i })).not.toBeInTheDocument()
  })
})
