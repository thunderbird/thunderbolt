/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createModel } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import type { FetchFn } from '@/lib/proxy-fetch'
import { ProxyFetchProvider } from '@/lib/proxy-fetch-context'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import type { Model } from '@/types'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import ModelsPage, { EditModelForm } from './index'

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

    const { triggerChange } = renderWithReactivity(<ModelsPage />, {
      tables: ['models'],
    })

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

const mockProxyFetch = (async () => new Response()) as unknown as FetchFn

const makeModel = (overrides?: Partial<Model>): Model =>
  ({
    id: 'test-model-id',
    name: 'My Model',
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-20241022',
    apiKey: 'sk-existing',
    url: null,
    isSystem: 0,
    enabled: 1,
    toolUsage: 1,
    isConfidential: 0,
    startWithReasoning: 0,
    supportsParallelToolCalls: 1,
    contextWindow: null,
    tokenizer: null,
    deletedAt: null,
    defaultHash: null,
    vendor: null,
    description: null,
    userId: null,
    ...overrides,
  }) as Model

const renderEditForm = (model: Model) =>
  render(
    <ProxyFetchProvider proxyFetch={mockProxyFetch}>
      <EditModelForm model={model} onCancel={() => {}} onSubmit={() => {}} isPending={false} />
    </ProxyFetchProvider>,
  )

describe('EditModelForm connection-test gate', () => {
  afterEach(() => {
    cleanup()
  })

  it('enables Save on rename-only edits without a passing connection test', () => {
    renderEditForm(makeModel())

    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed Model' } })

    expect(save).not.toBeDisabled()
  })

  it('shows a hint and keeps Save disabled when the API key is cleared on an anthropic model', () => {
    renderEditForm(makeModel({ provider: 'anthropic' }))

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: '' } })

    expect(screen.getByText('Enter an API key to test the connection before saving.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Test Model' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('requires a passing test when the API key changes on an anthropic model', () => {
    renderEditForm(makeModel({ provider: 'anthropic' }))

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'sk-rotated' } })

    expect(screen.getByRole('button', { name: 'Test Model' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
