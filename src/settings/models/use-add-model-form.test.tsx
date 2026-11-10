/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as modelsDal from '@/dal/models'
import { useChatStore } from '@/chats/chat-store'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getSettings, updateSettings } from '@/dal'
import { createModel, getAllModels, getModel, updateModel } from '@/dal/models'
import { exportUserData } from '@/dal/export'
import { getIntegrationCredentials } from '@/dal/integrations'
import { createTinfoilSession } from '@/lib/tinfoil-session'
import { getProviderConnectionAttempt } from '@/lib/provider-connection-attempt'
import * as tinfoilSessionModule from '@/lib/tinfoil-session'
import { tinfoilAuth, TinfoilReauthorizationError, type TinfoilCredentials } from '@/lib/tinfoil-auth'
import { http } from '@/lib/http'
import type { FetchFn } from '@/lib/proxy-fetch'
import { createTestProvider } from '@/test-utils/test-provider'
import { resetStore } from '@/test-utils/chat-store-mocks'
import { stubJsonResponse } from '@/test-utils/http'
import { renderWithReactivity } from '@/test-utils/powersync-reactivity-test'
import { getClock } from '@/testing-library'
import { act, cleanup, renderHook, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'
import { getLocalSetting, useLocalSettingsStore } from '@/stores/local-settings-store'
import { generateModelName, useAddModelForm } from './use-add-model-form'

/** Model-save tests represent an authorization started against the current local session. */
const currentAuthorization = async (credentials: TinfoilCredentials) => ({
  tinfoilCredentials: credentials,
  attempt: await getProviderConnectionAttempt(getDb(), 'tinfoil'),
})

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

/** A provider that answers chat completions but rejects any request carrying tools, as Ollama does. */
const toollessProxyFetch: FetchFn = Object.assign(
  async (_input: RequestInfo | URL, init?: RequestInit) =>
    String(init?.body).includes('"tools"')
      ? Response.json({ error: { message: 'gemma3:4b does not support tools' } }, { status: 400 })
      : Response.json({
          id: 'completion-id',
          object: 'chat.completion',
          created: 1,
          model: 'gemma3:4b',
          choices: [{ index: 0, message: { role: 'assistant', content: 'test successful' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
  { preconnect: async () => true },
)

describe('useAddModelForm', () => {
  let originalCloudUrl: string
  let originalLocalMode: boolean

  beforeEach(async () => {
    await resetTestDatabase()
    resetStore()
    originalCloudUrl = getLocalSetting('cloudUrl')
    originalLocalMode = getLocalSetting('localMode')
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example.com/v1', localMode: false })
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  afterEach(() => {
    cleanup()
    resetStore()
    useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl, localMode: originalLocalMode })
  })

  it.each(['resolve', 'reject'] as const)('keeps a replacement draft when an abandoned add %s', async (outcome) => {
    const pending = Promise.withResolvers<void>()
    const create = spyOn(modelsDal, 'createModelInTransaction').mockImplementation(() => pending.promise)
    const onClose = mock(() => {})
    try {
      const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose }), {
        wrapper: createTestProvider(),
      })
      const values = { provider: 'thunderbolt' as const, name: 'Original', model: 'original', supportsTools: true }
      const first = result.current.onSubmit(values)
      await result.current.onSubmit(values)
      await act(async () => {
        await getClock().runAllAsync()
      })
      expect(create).toHaveBeenCalledTimes(1)
      act(() => {
        result.current.onCancel()
        result.current.prepareForOpen()
        result.current.form.setValue('name', 'Replacement')
      })
      onClose.mockClear()
      await act(async () => {
        if (outcome === 'resolve') {
          pending.resolve()
        } else {
          pending.reject(new Error('old add failed'))
        }
        await first
        await getClock().runAllAsync()
      })
      expect(result.current.form.getValues('name')).toBe('Replacement')
      expect(result.current.submitError).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      create.mockRestore()
    }
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
        supportsTools: true,
      })
      await getClock().runAllAsync()
    })

    expect(useChatStore.getState().models.find((model) => model.name === 'New Chat Model')?.toolUsage).toBe(1)
    expect(onMutationStart).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('starts with a blank endpoint and selects the added model in standalone mode', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '' })
    const onClose = mock(() => {})
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose }), {
      wrapper: createTestProvider(),
    })
    expect(result.current.form.getValues('provider')).toBe('custom')
    expect(result.current.form.getValues('url')).toBe('')

    await act(async () => {
      result.current.onSubmit({
        provider: 'custom',
        name: 'My Local Model',
        model: 'local-model',
        supportsTools: true,
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
        supportsTools: true,
        name: 'DeepSeek',
        model: 'deepseek',
        apiKey: 'first-token',
        providerAuthorization: await currentAuthorization({
          access_token: 'first-token',
          refresh_token: 'refresh-token',
          expires_at: Date.now() + 3600000,
        }),
      }
      await act(async () => {
        await result.current.saveModel(values)
      })
      const original = (await getAllModels(getDb())).find((model) => model.oauthProvider === 'tinfoil')!
      expect(original.apiKey).toBeNull()
      const backup = JSON.stringify(await exportUserData(getDb(), { id: 'user', email: null }))
      expect(backup).not.toContain('first-token')
      expect(backup).not.toContain('refresh-token')
      expect(backup).toContain('own-key')
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
          enabled: 1,
          apiKey: null,
          oauthProvider: 'tinfoil',
        })
        await expect(session.getAccessToken()).rejects.toBeInstanceOf(TinfoilReauthorizationError)
        await act(async () => {
          await result.current.saveModel({
            ...values,
            providerDefault: 1,
            providerAuthorization: await currentAuthorization({
              ...values.providerAuthorization.tinfoilCredentials,
              access_token: accessToken,
            }),
          })
        })
        const oauthModels = (await getAllModels(getDb())).filter((model) => model.oauthProvider === 'tinfoil')
        expect(oauthModels).toHaveLength(1)
        expect(oauthModels[0]).toMatchObject({
          id: original.id,
          enabled: 1,
          apiKey: null,
          name: 'My renamed model',
          providerDefault: 1,
          toolUsage: 0,
          contextWindow: 8192,
        })
        expect((await getSettings(getDb(), { selected_model: '' })).selectedModel).toBe(original.id)
        expect((await getIntegrationCredentials(getDb(), 'tinfoil'))?.credentials.access_token).toBe(accessToken)
      }
      await updateModel(getDb(), original.id, { enabled: 0 })
      await session.disconnect()
      await act(async () => {
        await result.current.saveModel({
          ...values,
          providerAuthorization: await currentAuthorization(values.providerAuthorization.tinfoilCredentials),
        })
      })
      expect((await getModel(getDb(), original.id))?.enabled).toBe(0)
      expect(useChatStore.getState().models.some((model) => model.id === original.id)).toBe(false)
      expect(await getModel(getDb(), 'own-tinfoil-key')).toMatchObject({
        enabled: 1,
        apiKey: 'own-key',
        oauthProvider: null,
      })
    } finally {
      lockSpy.mockRestore()
    }
  })

  it('rolls back OAuth credentials and the model when cancellation arrives during the transaction', async () => {
    const controller = new AbortController()
    const create = modelsDal.createModelInTransaction
    const modelWrite = spyOn(modelsDal, 'createModelInTransaction').mockImplementation(async (...args) => {
      await create(...args)
      controller.abort()
    })
    const lock = spyOn(tinfoilSessionModule, 'withTinfoilSessionLock').mockImplementation(async (operation) =>
      operation(),
    )
    const onClose = mock(() => {})
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose }), {
      wrapper: createTestProvider(),
    })
    try {
      await act(async () => {
        await expect(
          result.current.saveModel({
            provider: 'tinfoil',
            oauthProvider: 'tinfoil',
            name: 'Tinfoil',
            model: 'deepseek',
            apiKey: 'access-token',
            supportsTools: true,
            providerAuthorization: await currentAuthorization({
              access_token: 'access-token',
              refresh_token: 'refresh-token',
              expires_at: 999999,
            }),
            signal: controller.signal,
          }),
        ).rejects.toHaveProperty('name', 'AbortError')
      })
      expect(await getAllModels(getDb())).toEqual([])
      expect(await getIntegrationCredentials(getDb(), 'tinfoil')).toBeNull()
      expect(result.current.submitError).toBeNull()
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      modelWrite.mockRestore()
      lock.mockRestore()
    }
  })

  it.each([
    ['openrouter', 1],
    ['openrouter', 0],
    ['tinfoil', 1],
    ['tinfoil', 0],
  ] as const)(
    'reuses the %s own-key default with enabled=%i and preserves manual models',
    async (provider, enabled) => {
      await createModel(getDb(), {
        id: 'manual',
        provider,
        name: 'Manual default with a different key',
        model: 'default-model',
        apiKey: 'manual-key',
      })
      const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: () => {} }), {
        wrapper: createTestProvider(),
      })
      const values = {
        provider,
        providerDefault: 1,
        name: 'Default model',
        model: 'default-model',
        apiKey: 'first-key',
        supportsTools: true,
      }
      await act(async () => {
        await result.current.saveModel(values)
      })
      const original = (await getAllModels(getDb())).find((model) => model.providerDefault === 1)!
      await updateSettings(getDb(), { selected_model: 'manual' })
      await updateModel(getDb(), original.id, {
        name: 'My renamed default',
        enabled,
        toolUsage: 0,
        contextWindow: 8192,
      })
      for (const apiKey of ['second-key', 'third-key']) {
        await updateModel(getDb(), original.id, { apiKey: null })
        await act(async () => {
          await result.current.saveModel({ ...values, apiKey })
        })
        const defaults = (await getAllModels(getDb())).filter((model) => model.providerDefault === 1)
        expect(defaults).toHaveLength(1)
        expect(defaults[0]).toMatchObject({
          id: original.id,
          enabled,
          name: 'My renamed default',
          toolUsage: 0,
          contextWindow: 8192,
          apiKey,
        })
        expect(await getModel(getDb(), 'manual')).toMatchObject({
          name: 'Manual default with a different key',
          apiKey: 'manual-key',
          providerDefault: null,
        })
        expect((await getSettings(getDb(), { selected_model: '' })).selectedModel).toBe('manual')
      }
    },
  )

  it('keeps automatically connected Tinfoil subscription and own-key models separate', async () => {
    await createModel(getDb(), {
      id: 'subscription-default',
      provider: 'tinfoil',
      oauthProvider: 'tinfoil',
      providerDefault: 1,
      name: 'Subscription default',
      model: 'default-model',
    })
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: () => {} }), {
      wrapper: createTestProvider(),
    })
    const values = {
      provider: 'tinfoil' as const,
      providerDefault: 1,
      name: 'Own-key default',
      model: 'default-model',
      apiKey: 'own-key',
      supportsTools: true,
    }
    await act(async () => {
      await result.current.saveModel(values)
      await result.current.saveModel({ ...values, apiKey: 'updated-key' })
    })
    const defaults = (await getAllModels(getDb())).filter((model) => model.providerDefault === 1)
    expect(defaults).toHaveLength(2)
    expect(defaults.find((model) => model.oauthProvider === 'tinfoil')).toMatchObject({
      id: 'subscription-default',
      name: 'Subscription default',
      apiKey: null,
    })
    expect(defaults.find((model) => !model.oauthProvider)).toMatchObject({
      name: 'Own-key default',
      apiKey: 'updated-key',
    })
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
          supportsTools: true,
          name: 'Default model',
          model: 'default-model',
          providerAuthorization: await currentAuthorization({
            access_token: 'token',
            expires_at: Date.now() + 3600000,
          }),
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

  it('surfaces a generic submit error without logging bound credentials when the mutation fails', async () => {
    // The mutation's onError logs the failure; muted so the test output stays clean.
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})
    const transactionSpy = spyOn(getDb(), 'transaction').mockImplementation(() => {
      throw new Error('Failed query: insert into models_secrets; params: sk-private-key,refresh-token')
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
          supportsTools: true,
        })
        await getClock().runAllAsync()
      })

      expect(result.current.submitError).toBe("Couldn't add the model. Please try again.")
      expect(consoleError).toHaveBeenCalledWith('Failed to add the model.')
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('sk-private-key')
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('refresh-token')
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      transactionSpy.mockRestore()
      consoleError.mockRestore()
    }
  })

  it('substitutes the typed custom model id on submit when Custom is selected', async () => {
    const completed = Promise.withResolvers<void>()
    const onClose = mock(() => completed.resolve())
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
        supportsTools: true,
      })
      await completed.promise
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

  it('does not request a local server when the standalone add-model panel opens', async () => {
    useLocalSettingsStore.setState({ cloudUrl: '', localMode: true })
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [] }))
    try {
      const { result } = renderHook(() => useAddModelForm({ isOpen: true, onClose: mock(() => {}) }), {
        wrapper: createTestProvider(),
      })
      await act(async () => {
        await getClock().runAllAsync()
      })
      expect(result.current.form.getValues('provider')).toBe('custom')
      expect(result.current.form.getValues('url')).toBe('')
      expect(getSpy).not.toHaveBeenCalled()
    } finally {
      getSpy.mockRestore()
    }
  })

  it('does not fetch a catalog when Custom is chosen before a URL is entered', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(stubJsonResponse({ data: [] }))
    const { result } = renderHook(() => useAddModelForm({ isOpen: true, onClose: mock(() => {}) }), {
      wrapper: createTestProvider(),
    })

    try {
      act(() => {
        result.current.onProviderChange('custom')
      })
      await act(async () => {
        getClock().tick(1000)
        await getClock().runAllAsync()
      })

      expect(result.current.form.getValues('url')).toBe('')
      expect(getSpy).not.toHaveBeenCalled()
    } finally {
      getSpy.mockRestore()
    }
  })

  it('saves a model that rejects tools with tool usage off after the connection test', async () => {
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: mock(() => {}) }), {
      wrapper: createTestProvider({ proxyFetch: toollessProxyFetch }),
    })

    act(() => {
      result.current.onProviderChange('custom')
      result.current.form.setValue('url', 'https://models.example.com/v1')
      result.current.form.setValue('model', 'gemma3:4b')
      result.current.form.setValue('name', 'Gemma')
    })
    await act(async () => {
      await result.current.onTestConnection()
    })

    expect(result.current.connectionStatus).toBe('success')
    expect(result.current.toolSupport).toBe('unsupported')
    expect(result.current.form.getValues('supportsTools')).toBe(false)

    await act(async () => {
      result.current.onSubmit(result.current.form.getValues())
      await getClock().runAllAsync()
    })

    expect(useChatStore.getState().models.find((model) => model.name === 'Gemma')?.toolUsage).toBe(0)
  })

  it('saves tool usage off when the switch is turned off by hand', async () => {
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: mock(() => {}) }), {
      wrapper: createTestProvider(),
    })

    await act(async () => {
      result.current.onSubmit({
        provider: 'thunderbolt',
        name: 'Toolless Model',
        model: 'toolless-model',
        customModel: '',
        url: '',
        apiKey: '',
        supportsTools: false,
      })
      await getClock().runAllAsync()
    })

    expect(useChatStore.getState().models.find((model) => model.name === 'Toolless Model')?.toolUsage).toBe(0)
  })

  it('turns tools back on when the provider changes', () => {
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: mock(() => {}) }), {
      wrapper: createTestProvider(),
    })

    act(() => {
      result.current.form.setValue('supportsTools', false)
      result.current.onProviderChange('custom')
    })

    expect(result.current.form.getValues('supportsTools')).toBe(true)
  })
})
