import { createModel } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import ModelsPage from './index'

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
    const modelId1 = uuidv7()
    await createModel({
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
    await createModel({
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
