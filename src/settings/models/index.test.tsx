/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createModel, getModel } from '@/dal'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { stubJsonResponse } from '@/test-utils/http'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { MemoryRouter } from 'react-router'
import ModelsPage from './index'
import { systemModelMenuMessage } from './model-detail'
import { useModelsPageState } from './use-models-page-state'
import { http } from '@/lib/http'

// The page consumes router state (the composer's "Add models" deep link), so
// it must render inside a router.
const renderModelsPage = () =>
  renderWithReactivity(
    <MemoryRouter>
      <ModelsPage />
    </MemoryRouter>,
    { tables: ['models'] },
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
    renderModelsPage()

    fireEvent.click(screen.getByRole('button', { name: 'New Model' }))
    await waitForElement(() => screen.queryByRole('heading', { name: 'Add Model' }))

    // Scope to the aside — the empty-state card renders its own "Add Model"
    // button on the page behind the panel.
    const panel = screen.getByRole('complementary')
    expect(within(panel).getByRole('button', { name: 'Add Model' })).toBeDisabled()
    expect(within(panel).queryByRole('button', { name: 'Refresh model catalog' })).not.toBeInTheDocument()
  })

  it('clears the picked model without validating untouched fields when the provider changes', async () => {
    // Drives the state hook directly — the regression (a stale 'custom'
    // selection surviving a provider switch and keeping the custom-ID field
    // rendered) lives in the hook, not the Radix widgets around it.
    const SelectionHarness = () => {
      const page = useModelsPageState()
      return (
        <div>
          <span data-testid="selected-model">{page.addForm.selectedModelId ?? ''}</span>
          <span data-testid="validation-errors">{Object.keys(page.addForm.form.formState.errors).join(',')}</span>
          <button onClick={() => page.addForm.onSelectModel('custom')}>select custom</button>
          <button onClick={() => page.addForm.onProviderChange('openai')}>switch provider</button>
        </div>
      )
    }
    renderWithReactivity(<SelectionHarness />, { tables: ['models'] })

    await act(async () => {
      fireEvent.click(screen.getByText('select custom'))
      await getClock().runAllAsync()
    })
    expect(screen.getByTestId('selected-model')).toHaveTextContent('custom')

    await act(async () => {
      fireEvent.click(screen.getByText('switch provider'))
      await getClock().runAllAsync()
    })
    expect(screen.getByTestId('selected-model')).toHaveTextContent('')
    expect(screen.getByTestId('validation-errors')).toBeEmptyDOMElement()
  })

  it('discards an abandoned add draft before replacing it with another panel', async () => {
    const DraftHarness = () => {
      const page = useModelsPageState()
      return (
        <div>
          <span data-testid="panel-kind">{page.panel?.kind ?? ''}</span>
          <span data-testid="provider">{page.addForm.form.watch('provider')}</span>
          <span data-testid="api-key">{page.addForm.form.watch('apiKey')}</span>
          <button onClick={page.openAddPanel}>open add</button>
          <button
            onClick={() => {
              page.addForm.onProviderChange('openai')
              page.addForm.form.setValue('apiKey', 'sk-abandoned')
            }}
          >
            enter draft
          </button>
          <button onClick={() => page.selectActiveModel('another-model')}>select model</button>
        </div>
      )
    }
    renderWithReactivity(<DraftHarness />, { tables: ['models'] })

    await act(async () => {
      fireEvent.click(screen.getByText('open add'))
      fireEvent.click(screen.getByText('enter draft'))
      await getClock().runAllAsync()
    })
    expect(screen.getByTestId('provider')).toHaveTextContent('openai')
    expect(screen.getByTestId('api-key')).toHaveTextContent('sk-abandoned')

    fireEvent.click(screen.getByText('select model'))
    expect(screen.getByTestId('panel-kind')).toHaveTextContent('detail')
    expect(screen.getByTestId('provider')).toHaveTextContent('thunderbolt')
    expect(screen.getByTestId('api-key')).toBeEmptyDOMElement()

    fireEvent.click(screen.getByText('open add'))
    expect(screen.getByTestId('panel-kind')).toHaveTextContent('add')
    expect(screen.getByTestId('api-key')).toBeEmptyDOMElement()
  })

  it('loads the catalog after API key edits settle', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(
      stubJsonResponse({ data: [{ id: 'gpt-test', name: 'GPT Test' }] }),
    )

    const AutoCatalogHarness = () => {
      const page = useModelsPageState()
      return (
        <div>
          <span data-testid="catalog-models">{page.addForm.modelItems.map((item) => item.label).join(',')}</span>
          <button onClick={page.openAddPanel}>open</button>
          <button onClick={() => page.addForm.onProviderChange('openai')}>select OpenAI</button>
          <button
            onClick={() => {
              page.addForm.form.setValue('apiKey', 'sk-test', { shouldValidate: false })
              page.addForm.onCatalogInvalidated()
            }}
          >
            enter API key
          </button>
        </div>
      )
    }

    try {
      renderWithReactivity(<AutoCatalogHarness />, { tables: ['models'] })
      fireEvent.click(screen.getByText('open'))
      fireEvent.click(screen.getByText('select OpenAI'))
      fireEvent.click(screen.getByText('enter API key'))

      await act(async () => {
        getClock().tick(499)
      })
      expect(getSpy).not.toHaveBeenCalled()

      await act(async () => {
        getClock().tick(1)
        await getClock().runAllAsync()
      })

      expect(getSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({ headers: { Authorization: 'Bearer sk-test' } }),
      )
      expect(screen.getByTestId('catalog-models')).toHaveTextContent('GPT Test')
    } finally {
      getSpy.mockRestore()
    }
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

    renderModelsPage()
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

    renderModelsPage()
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

    renderModelsPage()
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

    renderModelsPage()
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

    renderModelsPage()
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

    renderModelsPage()
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
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument()
  })

  it('does not request a provider catalog merely by opening edit', async () => {
    const db = getDb()
    await createModel(db, {
      id: uuidv7(),
      provider: 'openai',
      name: 'Private Key Model',
      model: 'gpt-4',
      apiKey: 'sk-never-send',
      isSystem: 0,
      enabled: 1,
    })
    const getSpy = spyOn(http, 'get')

    try {
      renderModelsPage()
      await waitForElement(() => screen.queryByText('Private Key Model'))
      await openMenuForModel('Private Key Model')
      fireEvent.click(await screen.findByText('Edit'))
      await screen.findByRole('heading', { name: 'Edit Model' })

      expect(getSpy).not.toHaveBeenCalled()
    } finally {
      getSpy.mockRestore()
    }
  })

  it('loads the catalog with the saved key when the model dropdown is opened', async () => {
    const db = getDb()
    await createModel(db, {
      id: uuidv7(),
      provider: 'openai',
      name: 'Saved Key Model',
      model: 'gpt-4',
      apiKey: 'sk-saved',
      isSystem: 0,
      enabled: 1,
    })
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [{ id: 'gpt-4o', name: 'GPT 4o' }] }))

    try {
      renderModelsPage()
      await waitForElement(() => screen.queryByText('Saved Key Model'))
      await openMenuForModel('Saved Key Model')
      fireEvent.click(await screen.findByText('Edit'))
      await screen.findByRole('heading', { name: 'Edit Model' })

      await act(async () => {
        fireEvent.click(screen.getByRole('combobox'))
        await getClock().runAllAsync()
      })

      expect(getSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({ headers: { Authorization: 'Bearer sk-saved' } }),
      )
      expect(await screen.findByText('GPT 4o')).toBeInTheDocument()
    } finally {
      getSpy.mockRestore()
    }
  })

  it('refreshes the edit catalog after a replacement API key settles', async () => {
    const db = getDb()
    await createModel(db, {
      id: uuidv7(),
      provider: 'openai',
      name: 'Editable Key Model',
      model: 'gpt-4',
      apiKey: 'sk-saved',
      isSystem: 0,
      enabled: 1,
    })
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [{ id: 'gpt-new', name: 'GPT New' }] }))

    try {
      renderModelsPage()
      await waitForElement(() => screen.queryByText('Editable Key Model'))
      await openMenuForModel('Editable Key Model')
      fireEvent.click(await screen.findByText('Edit'))
      fireEvent.change(await screen.findByLabelText('API Key'), { target: { value: 'sk-replacement' } })

      await act(async () => {
        getClock().tick(499)
      })
      expect(getSpy).not.toHaveBeenCalled()

      await act(async () => {
        getClock().tick(1)
        await getClock().runAllAsync()
      })

      expect(getSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/models',
        expect.objectContaining({ headers: { Authorization: 'Bearer sk-replacement' } }),
      )
    } finally {
      getSpy.mockRestore()
    }
  })

  it('never auto-sends a stored API key when only the URL is edited', async () => {
    const db = getDb()
    await createModel(db, {
      id: uuidv7(),
      provider: 'custom',
      name: 'Stored Key Custom Model',
      model: 'llama3',
      url: 'http://localhost:11434/v1',
      apiKey: 'sk-stored-secret',
      isSystem: 0,
      enabled: 1,
    })
    const getSpy = spyOn(http, 'get')

    try {
      renderModelsPage()
      await waitForElement(() => screen.queryByText('Stored Key Custom Model'))
      await openMenuForModel('Stored Key Custom Model')
      fireEvent.click(await screen.findByText('Edit'))
      fireEvent.change(await screen.findByLabelText('URL'), { target: { value: 'http://attacker.example/v1' } })

      // Even after the debounce settles, a URL-only edit on a model with a
      // stored key must not arm the auto-fetch — the key would ride along.
      await act(async () => {
        getClock().tick(1000)
        await getClock().runAllAsync()
      })

      expect(getSpy).not.toHaveBeenCalled()
    } finally {
      getSpy.mockRestore()
    }
  })

  it('saves name-only edits without requiring a new connection test', async () => {
    const db = getDb()
    const id = uuidv7()
    await createModel(db, {
      id,
      provider: 'openai',
      name: 'Old Name',
      model: 'gpt-4',
      apiKey: 'sk-saved',
      isSystem: 0,
      enabled: 1,
    })

    renderModelsPage()
    await waitForElement(() => screen.queryByText('Old Name'))
    await openMenuForModel('Old Name')
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'New Name' } })
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save).toBeEnabled()

    await act(async () => {
      fireEvent.click(save)
      await getClock().runAllAsync()
    })

    expect((await getModel(db, id))?.name).toBe('New Name')
    expect((await getModel(db, id))?.apiKey).toBe('sk-saved')
  })

  it('clears a retained local API key only after explicit confirmation', async () => {
    const db = getDb()
    const id = uuidv7()
    await createModel(db, {
      id,
      provider: 'openai',
      name: 'Clearable Key',
      model: 'gpt-4',
      apiKey: 'sk-remove',
      isSystem: 0,
      enabled: 1,
    })

    renderModelsPage()
    await waitForElement(() => screen.queryByText('Clearable Key'))
    await openMenuForModel('Clearable Key')
    fireEvent.click(await screen.findByText('Edit'))
    fireEvent.click(await screen.findByRole('button', { name: 'Clear saved API key' }))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
      await getClock().runAllAsync()
    })

    expect((await getModel(db, id))?.apiKey).toBeNull()
  })
})
