import { createAutomation, createModel } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import AutomationsPage from './index'

describe('AutomationsPage reactivity', () => {
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

  it('updates when prompts table changes', async () => {
    const modelId = uuidv7()
    await createModel({
      id: modelId,
      provider: 'openai',
      name: 'Test Model',
      model: 'gpt-4',
      isSystem: 0,
      enabled: 1,
    })

    const promptId1 = uuidv7()
    await createAutomation({
      id: promptId1,
      title: 'First Automation',
      prompt: 'First automation prompt',
      modelId,
    })

    const { triggerChange } = renderWithReactivity(<AutomationsPage />, {
      route: '/automations',
      routePath: '/automations',
      tables: ['prompts'],
    })

    await waitForElement(() => screen.queryByText('First Automation'))
    expect(screen.getByText('First Automation')).toBeInTheDocument()

    const promptId2 = uuidv7()
    await createAutomation({
      id: promptId2,
      title: 'Second Automation',
      prompt: 'Second automation prompt',
      modelId,
    })
    triggerChange(['prompts'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    expect(screen.getByText('Second Automation')).toBeInTheDocument()
  })
})
