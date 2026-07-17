/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createModel } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import ModelsPage, { systemModelMenuMessage } from './index'

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

describe('model card action menu', () => {
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

  /** Radix dropdown triggers open on pointerdown, not click. */
  const openMenuForModel = async (modelName: string) => {
    const card = screen.getByText(modelName).closest('[data-slot="card"]') as HTMLElement
    await act(async () => {
      fireEvent.pointerDown(within(card).getByLabelText('More'), { button: 0 })
    })
  }

  it('offers Edit and Delete for user-added models', async () => {
    const db = getDb()
    await createModel(db, {
      id: uuidv7(),
      provider: 'openai',
      name: 'User Model',
      model: 'gpt-4',
      isSystem: 0,
      enabled: 1,
    })

    renderWithReactivity(<ModelsPage />, { tables: ['models'] })
    await waitForElement(() => screen.queryByText('User Model'))

    await openMenuForModel('User Model')

    expect(await screen.findByText('Edit')).toBeInTheDocument()
    expect(screen.getByText('Delete')).toBeInTheDocument()
    expect(screen.queryByText(systemModelMenuMessage)).not.toBeInTheDocument()
  })

  it('explains instead of offering Edit/Delete for built-in models', async () => {
    const db = getDb()
    await createModel(db, {
      id: uuidv7(),
      provider: 'thunderbolt',
      name: 'Built-in Model',
      model: 'built-in',
      isSystem: 1,
      enabled: 1,
    })

    renderWithReactivity(<ModelsPage />, { tables: ['models'] })
    await waitForElement(() => screen.queryByText('Built-in Model'))

    await openMenuForModel('Built-in Model')

    expect(await screen.findByText(systemModelMenuMessage)).toBeInTheDocument()
    expect(screen.queryByText('Edit')).not.toBeInTheDocument()
    expect(screen.queryByText('Delete')).not.toBeInTheDocument()
  })
})
