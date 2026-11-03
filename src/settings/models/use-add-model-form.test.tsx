/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useChatStore } from '@/chats/chat-store'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getSettings } from '@/dal'
import { createModel, getAllModels, getModel, updateModel } from '@/dal/models'
import { getIntegrationCredentials } from '@/dal/integrations'
import { createTinfoilSession } from '@/lib/tinfoil-session'
import * as tinfoilSessionModule from '@/lib/tinfoil-session'
import { tinfoilAuth, TinfoilReauthorizationError } from '@/lib/tinfoil-auth'
import { http } from '@/lib/http'
import { createTestProvider } from '@/test-utils/test-provider'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { stubJsonResponse } from '@/test-utils/http'
import { renderWithReactivity } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getLocalSetting, useLocalSettingsStore } from '@/stores/local-settings-store'
import { generateModelName, useAddModelForm } from './use-add-model-form'

describe('generateModelName', () => {
  it('title-cases hyphenated ids and keeps version numbers intact', () => {
    expect(generateModelName('gpt-4-turbo')).toBe('Gpt 4 Turbo')
    expect(generateModelName('claude-3-5-sonnet')).toBe('Claude 3 5 Sonnet')
  })

  it('drops the vendor prefix and tag suffix', () => {
    expect(generateModelName('anthropic/claude-3-haiku')).toBe('Claude 3 Haiku')
    expect(generateModelName('llama3:latest')).toBe('Llama 3')
  })

  it('keeps letter-digit model families like o1 together', () => {
    expect(generateModelName('o1-preview')).toBe('O1 Preview')
  })

  it('preserves decimal versions', () => {
    expect(generateModelName('glm-5.2')).toBe('Glm 5.2')
  })
})

describe('useAddModelForm', () => {
  let originalCloudUrl: string
  let originalLocalMode: boolean

  beforeEach(() => {
    originalCloudUrl = getLocalSetting('cloudUrl')
    originalLocalMode = getLocalSetting('localMode')
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example.com/v1', localMode: false })
  })
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(async () => {
    cleanup()
    resetStore()
    useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl, localMode: originalLocalMode })
    await resetTestDatabase()
  })

  it('refreshes the chat model list before closing after creation', async () => {
    const onClose = mock(() => {})
    const onMutationStart = mock(() => {})
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose, onMutationStart }), {
      wrapper: createTestProvider(),
    })

    await act(async () => {
      result.current.onSubmit({
        provider: 'thunderbolt',
        name: 'New Chat Model',
        model: 'new-chat-model',
        customModel: '',
        url: '',
        apiKey: '',
      })
      await getClock().runAllAsync()
    })

    expect(useChatStore.getState().models.some((model) => model.name === 'New Chat Model')).toBe(true)
    expect(onMutationStart).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('defaults to a local endpoint and selects the added model in standalone mode', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '' })
    const onClose = mock(() => {})
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose }), {
      wrapper: createTestProvider(),
    })
    expect(result.current.form.getValues('provider')).toBe('custom')
    expect(result.current.form.getValues('url')).toBe('http://localhost:11434/v1')

    await act(async () => {
      result.current.onSubmit({
        provider: 'custom',
        name: 'My Local Model',
        model: 'local-model',
        url: 'http://localhost:11434/v1',
        apiKey: '',
      })
      await getClock().runAllAsync()
    })

    const model = useChatStore.getState().models.find((candidate) => candidate.name === 'My Local Model')
    const settings = await getSettings(getDb(), { selected_model: '' })
    expect(model).toBeDefined()
    expect(model?.id).toBe(settings.selectedModel)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reuses the OAuth model across disconnect and reconnect without changing a matching API-key model', async () => {
    const lockSpy = spyOn(tinfoilSessionModule, 'withTinfoilSessionLock').mockImplementation(async (operation) =>
      operation(),
    )
    try {
      useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
      await createModel(getDb(), {
        id: 'own-tinfoil-key',
        provider: 'tinfoil',
        name: 'My DeepSeek',
        model: 'deepseek',
        apiKey: 'own-key',
      })
      const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: () => {} }), {
        wrapper: createTestProvider(),
      })
      const values = {
        provider: 'tinfoil' as const,
        oauthProvider: 'tinfoil' as const,
        name: 'DeepSeek',
        model: 'deepseek',
        tinfoilCredentials: {
          access_token: 'first-token',
          refresh_token: 'refresh-token',
          expires_at: Date.now() + 3600000,
        },
      }
      await act(async () => {
        await result.current.saveModel(values)
      })
      const original = (await getAllModels(getDb())).find((model) => model.oauthProvider === 'tinfoil')!
      await updateModel(getDb(), original.id, { name: 'My renamed model', toolUsage: 0, contextWindow: 8192 })
      const session = createTinfoilSession({
        db: getDb,
        auth: { ...tinfoilAuth, revoke: mock(async () => {}) },
        lock: async (operation) => operation(),
        now: Date.now,
      })

      for (const accessToken of ['second-token', 'third-token']) {
        await session.disconnect()
        expect(await getModel(getDb(), original.id)).toMatchObject({
          enabled: 0,
          apiKey: null,
          oauthProvider: 'tinfoil',
        })
        await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
        await act(async () => {
          await result.current.saveModel({
            ...values,
            tinfoilCredentials: { ...values.tinfoilCredentials, access_token: accessToken },
          })
        })
        const oauthModels = (await getAllModels(getDb())).filter((model) => model.oauthProvider === 'tinfoil')
        expect(oauthModels).toHaveLength(1)
        expect(oauthModels[0]).toMatchObject({
          id: original.id,
          enabled: 1,
          apiKey: null,
          name: 'My renamed model',
          toolUsage: 0,
          contextWindow: 8192,
        })
        expect((await getSettings(getDb(), { selected_model: '' })).selectedModel).toBe(original.id)
        expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials.access_token).toBe(accessToken)
      }
      expect(await getModel(getDb(), 'own-tinfoil-key')).toMatchObject({
        enabled: 1,
        apiKey: 'own-key',
        oauthProvider: null,
      })
    } finally {
      lockSpy.mockRestore()
    }
  })

  it('does not overwrite a different OAuth model when connecting the provider default', async () => {
    const lockSpy = spyOn(tinfoilSessionModule, 'withTinfoilSessionLock').mockImplementation(async (operation) =>
      operation(),
    )
    try {
      await createModel(getDb(), {
        id: 'customized-oauth-model',
        provider: 'tinfoil',
        oauthProvider: 'tinfoil',
        name: 'My other model',
        model: 'other-model',
        enabled: 0,
      })
      const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: () => {} }), {
        wrapper: createTestProvider(),
      })
      await act(async () => {
        await result.current.saveModel({
          provider: 'tinfoil',
          oauthProvider: 'tinfoil',
          name: 'Default model',
          model: 'default-model',
          tinfoilCredentials: { access_token: 'token', expires_at: Date.now() + 3600000 },
        })
      })
      expect(await getModel(getDb(), 'customized-oauth-model')).toMatchObject({
        name: 'My other model',
        model: 'other-model',
        enabled: 0,
      })
      expect((await getAllModels(getDb())).filter((model) => model.oauthProvider === 'tinfoil')).toHaveLength(2)
    } finally {
      lockSpy.mockRestore()
    }
  })

  it('keeps server models unavailable while a local user has only selected a server', () => {
    useLocalSettingsStore.setState({ cloudUrl: 'https://chosen.example.com/v1', localMode: true })
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: () => {} }), {
      wrapper: createTestProvider(),
    })
    expect(result.current.allowServerModels).toBe(false)
    expect(result.current.form.getValues('provider')).toBe('custom')
  })

  it('supports local model settings without an authentication provider', () => {
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
    const ModelForm = () => {
      const form = useAddModelForm({ isOpen: false, onClose: () => {} })
      return (
        <output data-testid="provider-mode">
          {form.form.getValues('provider')}:{String(form.allowServerModels)}
        </output>
      )
    }

    renderWithReactivity(<ModelForm />)

    expect(screen.getByTestId('provider-mode').textContent).toBe('custom:false')
  })

  it('surfaces the submit error and stays open when the create mutation fails', async () => {
    // The mutation's onError logs the failure; muted so the test output stays clean.
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const transactionSpy = spyOn(getDb(), 'transaction').mockImplementation(() => {
      throw new Error('insert failed')
    })
    const onClose = mock(() => {})
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose }), {
      wrapper: createTestProvider(),
    })

    try {
      await act(async () => {
        result.current.onSubmit({
          provider: 'thunderbolt',
          name: 'Broken Model',
          model: 'broken-model',
          customModel: '',
          url: '',
          apiKey: '',
        })
        await getClock().runAllAsync()
      })

      expect(result.current.submitError).toBe("Couldn't add the model. Please try again.")
      expect(consoleError).toHaveBeenCalledWith('Failed to add the model.', expect.any(Error))
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      transactionSpy.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('substitutes the typed custom model id on submit when Custom is selected', async () => {
    const onClose = mock(() => {})
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose }), {
      wrapper: createTestProvider(),
    })

    act(() => {
      result.current.onSelectModel('custom')
    })

    await act(async () => {
      result.current.onSubmit({
        provider: 'thunderbolt',
        name: 'My Custom Model',
        model: 'ignored-model',
        customModel: 'gpt-4-turbo-preview',
        url: '',
        apiKey: '',
      })
      await getClock().runAllAsync()
    })

    const created = useChatStore.getState().models.find((candidate) => candidate.name === 'My Custom Model')
    expect(created?.model).toBe('gpt-4-turbo-preview')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not refetch an already requested catalog when visibility alone changes', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [{ id: 'gpt-test' }] }))
    const onClose = mock(() => {})
    const { result, rerender } = renderHook(({ isOpen }: { isOpen: boolean }) => useAddModelForm({ isOpen, onClose }), {
      initialProps: { isOpen: true },
      wrapper: createTestProvider(),
    })

    try {
      act(() => {
        result.current.onProviderChange('openai')
        result.current.form.setValue('apiKey', 'sk-test')
        result.current.onCatalogInvalidated()
      })
      await act(async () => {
        getClock().tick(500)
        await getClock().runAllAsync()
      })
      expect(getSpy).toHaveBeenCalledTimes(1)

      rerender({ isOpen: false })
      rerender({ isOpen: true })
      await act(async () => {
        await getClock().runAllAsync()
      })

      expect(getSpy).toHaveBeenCalledTimes(1)
    } finally {
      getSpy.mockRestore()
    }
  })
})
