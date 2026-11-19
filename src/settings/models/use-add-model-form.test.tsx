/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import * as modelsDal from '@/dal/models'
import { useChatStore } from '@/chats/chat-store'
import { resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { getDb } from '@/db/database'
import { getSettings } from '@/dal'
import { createModel, getAllModels, getModel, updateModel } from '@/dal/models'
import { exportUserData } from '@/dal/export'
import { getIntegrationCredentials } from '@/dal/integrations'
import {
  disconnectProviderConnection,
  getProviderConnections,
  getProviderCredentials,
} from '@/dal/provider-connections'
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
import { useAddModelForm } from './use-add-model-form'

/** Model-save tests represent an authorization started against the current local session. */
const currentAuthorization = async (credentials: TinfoilCredentials) => ({
  tinfoilCredentials: credentials,
  attempt: await getProviderConnectionAttempt(getDb(), 'tinfoil'),
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
    spyOn(tinfoilAuth, 'revoke').mockResolvedValue()
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
    mock.restore()
    resetStore()
    useLocalSettingsStore.setState({ cloudUrl: originalCloudUrl, localMode: originalLocalMode })
  })

  it.each(['resolve', 'reject'] as const)('keeps a replacement draft when an abandoned add %s', async (outcome) => {
    const pending = Promise.withResolvers<void>()
    const started = Promise.withResolvers<void>()
    const create = spyOn(modelsDal, 'createModelInTransaction').mockImplementation(() => {
      started.resolve()
      return pending.promise
    })
    const onClose = mock(() => {})
    try {
      const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose }), {
        wrapper: createTestProvider(),
      })
      const values = { provider: 'thunderbolt' as const, name: 'Original', model: 'original', supportsTools: true }
      const first = result.current.onSubmit(values)
      await result.current.onSubmit(values)
      await act(async () => {
        await started.promise
        await getClock().tickAsync(0)
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
      pending.resolve()
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
      expect(original).toMatchObject({ apiKey: 'first-token', providerConnectionId: 'oauth:tinfoil' })
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
          apiKey: accessToken,
          providerConnectionId: 'oauth:tinfoil',
          name: 'My renamed model',
          providerDefault: null,
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
      expect(await getProviderCredentials(getDb(), 'oauth:tinfoil')).toBeNull()
      expect(await getProviderConnections(getDb())).toEqual([])
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
    'creates separate %s API-key connections and preserves existing model preferences (enabled=%i)',
    async (provider, enabled) => {
      await createModel(getDb(), {
        id: 'manual',
        provider,
        name: 'Manual model',
        model: 'default-model',
        apiKey: 'manual-key',
      })
      const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: () => {} }), {
        wrapper: createTestProvider(),
      })
      const values = {
        provider,
        name: 'Default model',
        model: 'default-model',
        apiKey: 'first-key',
        supportsTools: true,
      }
      let originalId = ''
      await act(async () => {
        originalId = (await result.current.saveModel(values)).id
      })
      const original = (await getModel(getDb(), originalId))!
      expect(original.providerConnectionId).toBeTruthy()
      expect((await getProviderConnections(getDb()))[0].authMethod).toBe('api_key')
      await updateModel(getDb(), original.id, { name: 'My renamed model', enabled, toolUsage: 0, contextWindow: 8192 })
      await disconnectProviderConnection(getDb(), original.providerConnectionId!)
      let nextId = ''
      await act(async () => {
        nextId = (await result.current.saveModel({ ...values, apiKey: 'second-key' })).id
      })
      expect(nextId).not.toBe(original.id)
      expect(await getModel(getDb(), original.id)).toMatchObject({
        name: 'My renamed model',
        enabled,
        toolUsage: 0,
        contextWindow: 8192,
        apiKey: null,
      })
      expect(await getModel(getDb(), nextId)).toMatchObject({ apiKey: 'second-key', oauthProvider: null })
      expect(await getModel(getDb(), 'manual')).toMatchObject({ name: 'Manual model', apiKey: 'manual-key' })
      expect(await getProviderConnections(getDb())).toHaveLength(2)
    },
  )

  it('keeps Tinfoil OAuth and multiple API-key connections separate', async () => {
    const lock = spyOn(tinfoilSessionModule, 'withTinfoilSessionLock').mockImplementation(async (operation) =>
      operation(),
    )
    try {
      const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: () => {} }), {
        wrapper: createTestProvider(),
      })
      const values = {
        provider: 'tinfoil' as const,
        name: 'Default model',
        model: 'default-model',
        apiKey: 'oauth-key',
        supportsTools: true,
      }
      await act(async () => {
        await result.current.saveModel({
          ...values,
          providerAuthorization: await currentAuthorization({
            access_token: 'oauth-key',
            expires_at: Date.now() + 900_000,
          }),
        })
        await result.current.saveModel({ ...values, apiKey: 'first-own-key' })
        await result.current.saveModel({ ...values, apiKey: 'second-own-key' })
      })
      const models = await getAllModels(getDb())
      expect(models).toHaveLength(3)
      expect(new Set(models.map((model) => model.providerConnectionId)).size).toBe(3)
      expect(models.find((model) => model.providerConnectionId === 'oauth:tinfoil')).toMatchObject({
        apiKey: 'oauth-key',
        oauthProvider: 'tinfoil',
      })
      expect(
        models
          .filter((model) => !model.oauthProvider)
          .map((model) => model.apiKey)
          .sort(),
      ).toEqual(['first-own-key', 'second-own-key'])
    } finally {
      lock.mockRestore()
    }
  })

  it('reuses one Otari OAuth connection across servers while preserving model IDs and preferences', async () => {
    const values = {
      provider: 'otari' as const,
      name: 'Workspace model',
      model: 'example/model',
      url: 'https://otari.example.com/api/v1',
      apiKey: 'delegated-key',
      supportsTools: true,
    }
    await createModel(getDb(), { ...values, id: 'manual', apiKey: 'manual-key' })
    const { result } = renderHook(() => useAddModelForm({ isOpen: false, onClose: () => {} }), {
      wrapper: createTestProvider(),
    })
    let originalId = ''
    await act(async () => {
      originalId = (
        await result.current.saveModel({
          ...values,
          providerAuthorization: { attempt: await getProviderConnectionAttempt(getDb(), 'otari') },
        })
      ).id
    })
    await updateModel(getDb(), originalId, { name: 'My model', enabled: 0, toolUsage: 0, contextWindow: 8192 })
    await act(async () => {
      await result.current.saveModel({
        ...values,
        url: 'https://other.example.com/api/v1',
        apiKey: 'replacement-key',
        providerAuthorization: { attempt: await getProviderConnectionAttempt(getDb(), 'otari') },
      })
    })
    expect(await getAllModels(getDb())).toHaveLength(2)
    expect(await getModel(getDb(), originalId)).toMatchObject({
      providerConnectionId: 'oauth:otari',
      name: 'My model',
      enabled: 0,
      toolUsage: 0,
      contextWindow: 8192,
      apiKey: 'replacement-key',
      url: 'https://other.example.com/api/v1',
    })
    expect(await getModel(getDb(), 'manual')).toMatchObject({ apiKey: 'manual-key', url: values.url })
    expect(await getProviderConnections(getDb())).toHaveLength(1)
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

  it('uses shared display names for catalog and unlisted model selections without changing model IDs', async () => {
    const getSpy = spyOn(http, 'get').mockReturnValue(
      stubJsonResponse({
        data: [
          { id: 'vendor/opaque-123', name: ' DeepSeek V4.1 Flash ' },
          { id: 'deepseek/deepseek-v4.1-flash', name: 'deepseek/deepseek-v4.1-flash' },
        ],
      }),
    )
    const { result } = renderHook(() => useAddModelForm({ isOpen: true, onClose: mock(() => {}) }), {
      wrapper: createTestProvider(),
    })
    try {
      act(() => {
        result.current.onProviderChange('openai')
        result.current.form.setValue('apiKey', 'sk-test')
      })
      await act(async () => getClock().runAllAsync())
      for (const [id, name] of [
        ['vendor/opaque-123', 'DeepSeek V4.1 Flash'],
        ['deepseek/deepseek-v4.1-flash', 'Deepseek v4.1 Flash'],
        ['llama3:latest', 'Llama 3'],
      ]) {
        act(() => result.current.onSelectModel(id))
        expect(result.current.form.getValues('name')).toBe(name)
        expect(result.current.form.getValues('model')).toBe(id)
      }
    } finally {
      getSpy.mockRestore()
    }
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
