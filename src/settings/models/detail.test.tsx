import { createModel, updateModel } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import ModelDetailPage from './detail'

describe('ModelDetailPage reactivity', () => {
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
    const modelId = uuidv7()
    await createModel({
      id: modelId,
      provider: 'openai',
      name: 'Original Name',
      model: 'gpt-4',
      isSystem: 0,
      enabled: 1,
    })

    const { triggerChange } = renderWithReactivity(<ModelDetailPage />, {
      route: `/settings/models/${modelId}`,
      routePath: '/settings/models/:modelId',
      tables: ['models'],
    })

    await waitForElement(() => screen.queryByDisplayValue('Original Name'))
    expect(screen.getByDisplayValue('Original Name')).toBeInTheDocument()

    await updateModel(modelId, { name: 'Updated Name' })
    triggerChange(['models'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByDisplayValue('Updated Name')).toBeInTheDocument()
  })
})
