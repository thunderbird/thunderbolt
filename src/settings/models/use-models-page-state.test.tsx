/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { useChatStore } from '@/chats/chat-store'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { createModel, getAvailableModels } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getClock } from '@/testing-library'
import { renderWithReactivity } from '@/test-utils/powersync-reactivity-test'
import { defaultModels } from '@shared/defaults/models'
import { useModelsPageState } from './use-models-page-state'

const MutationHarness = ({ id }: { id: string }) => {
  const page = useModelsPageState()
  return (
    <>
      <button onClick={() => page.toggleModel(id, false)}>disable</button>
      <button onClick={() => page.toggleModel(id, true)}>enable</button>
      <button onClick={() => page.submitEdit({ id, name: 'Edited', model: 'new-model', toolUsage: 0 })}>edit</button>
      <button onClick={() => page.requestDelete(id)}>delete</button>
      <button onClick={page.confirmDelete}>confirm</button>
      <button onClick={() => page.resetModel(id)}>reset</button>
    </>
  )
}

const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }))
    await getClock().runAllAsync()
  })
}

describe('model settings update active chat availability', () => {
  beforeAll(setupTestDatabase)
  afterAll(teardownTestDatabase)
  beforeEach(async () => {
    resetStore()
    await resetTestDatabase()
    await createModel(getDb(), {
      id: 'editable',
      name: 'Original',
      provider: 'openai',
      model: 'old-model',
      apiKey: 'old-key',
      enabled: 1,
    })
    useChatStore.getState().setModels(await getAvailableModels(getDb()))
  })
  afterEach(() => {
    cleanup()
    resetStore()
  })

  it('removes disabled models immediately and restores them when enabled', async () => {
    renderWithReactivity(<MutationHarness id="editable" />, { tables: ['models'] })
    await click('disable')
    expect(useChatStore.getState().models).toEqual([])
    await click('enable')
    expect(useChatStore.getState().models.map((model) => model.id)).toEqual(['editable'])
  })

  it('refreshes model and tool preferences without changing provider credentials', async () => {
    renderWithReactivity(<MutationHarness id="editable" />, { tables: ['models'] })
    await click('edit')
    expect(useChatStore.getState().models[0]).toMatchObject({
      id: 'editable',
      name: 'Edited',
      model: 'new-model',
      apiKey: 'old-key',
      toolUsage: 0,
    })
  })

  it('does not log bound credentials from a failed edit query', async () => {
    renderWithReactivity(<MutationHarness id="editable" />, { tables: ['models'] })
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const transaction = spyOn(getDb(), 'transaction').mockImplementation(() => {
      throw new Error('Failed query: update models_secrets; params: new-key')
    })
    try {
      await click('edit')
      expect(consoleError).toHaveBeenCalledWith('Failed to save the model.')
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('new-key')
      expect(useChatStore.getState().models[0].apiKey).toBe('old-key')
    } finally {
      transaction.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('removes soft-deleted models from active chat choices', async () => {
    renderWithReactivity(<MutationHarness id="editable" />, { tables: ['models'] })
    await click('delete')
    await click('confirm')
    expect(useChatStore.getState().models).toEqual([])
  })

  it('refreshes a reset default instead of retaining its edited credentials', async () => {
    const model = defaultModels[0]
    await createModel(getDb(), { ...model, name: 'Edited default', apiKey: 'stale-key' })
    useChatStore.getState().setModels(await getAvailableModels(getDb()))
    renderWithReactivity(<MutationHarness id={model.id} />, { tables: ['models'] })
    await click('reset')
    expect(useChatStore.getState().models.find((row) => row.id === model.id)).toMatchObject({
      name: model.name,
      model: model.model,
      apiKey: null,
    })
  })
})
