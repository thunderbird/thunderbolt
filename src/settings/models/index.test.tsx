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
import ModelsPage, { shouldDisableAddModel, systemModelMenuMessage } from './index'

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

describe('add model form', () => {
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

  it('disables Add Model while required fields are empty', async () => {
    renderWithReactivity(<ModelsPage />, { tables: ['models'] })

    fireEvent.click(screen.getByRole('button', { name: 'Add model' }))
    await waitForElement(() => screen.queryByRole('heading', { name: 'Add Model' }))

    // Scope to the aside — the empty-state card renders its own "Add Model"
    // button on the page behind the panel.
    const panel = screen.getByRole('complementary')
    expect(within(panel).getByRole('button', { name: 'Add Model' })).toBeDisabled()
  })
})

describe('shouldDisableAddModel', () => {
  it('enables submission only when validation and connection gates pass', () => {
    expect(shouldDisableAddModel(false, true, false, false)).toBe(false)
    expect(shouldDisableAddModel(false, true, true, true)).toBe(false)
    expect(shouldDisableAddModel(false, false, false, false)).toBe(true)
    expect(shouldDisableAddModel(false, true, true, false)).toBe(true)
    expect(shouldDisableAddModel(true, true, false, false)).toBe(true)
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

  /** Open the row detail, then its Radix actions menu (pointerdown, not click). */
  const openMenuForModel = async (modelName: string) => {
    fireEvent.click(screen.getByRole('button', { name: `Open ${modelName}` }))
    await act(async () => {
      fireEvent.pointerDown(screen.getByLabelText('More'), { button: 0 })
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

  it('keeps cards concise and opens model configuration in the detail panel', async () => {
    const db = getDb()
    await createModel(db, {
      id: uuidv7(),
      provider: 'openai',
      name: 'Concise Model',
      model: 'gpt-detail-only',
      isSystem: 0,
      enabled: 1,
    })

    renderWithReactivity(<ModelsPage />, { tables: ['models'] })
    await waitForElement(() => screen.queryByText('Concise Model'))

    const card = screen.getByText('Concise Model').closest('[data-slot="card"]') as HTMLElement
    expect(within(card).getByText('OpenAI')).toBeInTheDocument()
    expect(within(card).queryByText('gpt-detail-only')).not.toBeInTheDocument()
    expect(within(card).queryByLabelText('More')).not.toBeInTheDocument()
    expect(within(card).getByRole('switch', { name: 'Disable Concise Model' })).toBeInTheDocument()

    fireEvent.click(within(card).getByRole('button', { name: 'Open Concise Model' }))

    expect(screen.getByText('gpt-detail-only')).toBeInTheDocument()
    expect(screen.getByLabelText('More')).toBeInTheDocument()
  })

  it('brands system-managed Tinfoil transport models as Thunderbolt', async () => {
    const db = getDb()
    await createModel(db, {
      id: uuidv7(),
      provider: 'tinfoil',
      name: 'GLM 5.2',
      model: 'glm-5-2',
      isSystem: 1,
      enabled: 1,
      isConfidential: 1,
    })

    renderWithReactivity(<ModelsPage />, { tables: ['models'] })
    await waitForElement(() => screen.queryByText('GLM 5.2'))

    const card = screen.getByText('GLM 5.2').closest('[data-slot="card"]') as HTMLElement
    expect(within(card).getByText('Thunderbolt')).toBeInTheDocument()
    expect(within(card).queryByText('Tinfoil')).not.toBeInTheDocument()
  })

  it('swaps the detail panel to an inline edit form and back on cancel', async () => {
    const db = getDb()
    await createModel(db, {
      id: uuidv7(),
      provider: 'openai',
      name: 'Editable Model',
      model: 'gpt-4',
      isSystem: 0,
      enabled: 1,
    })

    renderWithReactivity(<ModelsPage />, { tables: ['models'] })
    await waitForElement(() => screen.queryByText('Editable Model'))

    await openMenuForModel('Editable Model')
    fireEvent.click(await screen.findByText('Edit'))

    // The edit form replaces the detail content inside the same panel — no
    // separate dialog opens.
    expect(await screen.findByRole('heading', { name: 'Edit Model' })).toBeInTheDocument()
    expect(screen.getByLabelText('Name')).toHaveValue('Editable Model')
    expect(document.querySelector('[data-slot="responsive-modal-content"]')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('heading', { name: 'Edit Model' })).not.toBeInTheDocument()
    expect(screen.getByText('gpt-4')).toBeInTheDocument()
  })

  it('masks the saved API key and offers the model as a selector in the edit form', async () => {
    const db = getDb()
    await createModel(db, {
      id: uuidv7(),
      provider: 'openai',
      name: 'Keyed Model',
      model: 'gpt-4',
      apiKey: 'sk-secret-123',
      isSystem: 0,
      enabled: 1,
    })

    renderWithReactivity(<ModelsPage />, { tables: ['models'] })
    await waitForElement(() => screen.queryByText('Keyed Model'))

    await openMenuForModel('Keyed Model')
    fireEvent.click(await screen.findByText('Edit'))
    await waitForElement(() => screen.queryByRole('heading', { name: 'Edit Model' }))

    // The stored key never appears in the field — only a masked placeholder.
    const apiKeyInput = screen.getByLabelText('API Key') as HTMLInputElement
    expect(apiKeyInput.value).toBe('')
    expect(apiKeyInput.placeholder).toContain('•')

    // The model field is a dropdown seeded with the stored model id.
    const modelTrigger = screen.getByRole('combobox')
    expect(modelTrigger).toHaveTextContent('gpt-4')
  })
})
