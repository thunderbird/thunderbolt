/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createChatThread, createModel, updateChatThread } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import type { Model } from '@/types'
import '@testing-library/jest-dom'
import { act, cleanup, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { useContextTracking } from './use-context-tracking'

const TestContextTrackingComponent = ({ chatThreadId, model }: { chatThreadId: string; model: Model }) => {
  const { usedTokens } = useContextTracking({
    model,
    chatThreadId,
    currentInput: '',
  })
  return <span data-testid="used-tokens">{usedTokens ?? 'null'}</span>
}

describe('useContextTracking reactivity', () => {
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

  it('updates when chat_threads contextSize changes', async () => {
    const db = getDb()
    const modelId = uuidv7()
    const threadId = uuidv7()

    await createModel(db, {
      id: modelId,
      provider: 'openai',
      name: 'Test Model',
      model: 'gpt-4',
      isSystem: 0,
      enabled: 1,
      contextWindow: 128000,
    })

    const model = await import('@/dal').then((m) => m.getModel(db, modelId))
    if (!model) {
      throw new Error('Model not found')
    }

    await createChatThread(
      db,
      { id: threadId, title: 'Test', contextSize: null, triggeredBy: null, wasTriggeredByAutomation: 0 },
      model,
    )

    const { triggerChange } = renderWithReactivity(
      <TestContextTrackingComponent chatThreadId={threadId} model={model} />,
      { tables: ['chat_threads'] },
    )

    await waitForElement(() => screen.queryByTestId('used-tokens'))
    expect(screen.getByTestId('used-tokens').textContent).toBe('null')

    await act(async () => {
      await getClock().runAllAsync()
    })

    await updateChatThread(db, threadId, { contextSize: 500 })
    triggerChange(['chat_threads'])

    await act(async () => {
      await getClock().runAllAsync()
    })

    await waitForElement(() => {
      const el = screen.queryByTestId('used-tokens')
      return el?.textContent === '500' ? el : null
    })
    expect(screen.getByTestId('used-tokens').textContent).toBe('500')
  })
})
