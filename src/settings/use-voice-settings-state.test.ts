/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import type { VoiceProviderConfig } from '@/stores/local-settings-store'
import { useVoiceSettingsState } from './use-voice-settings-state'

const config: VoiceProviderConfig = {
  kind: 'openai-compatible',
  baseUrl: 'https://a.example/v1',
  apiKey: '',
  sttModel: 'stt',
  ttsModel: 'tts',
  ttsVoice: 'voice',
}
const models = { stt: ['stt'], tts: [{ id: 'tts', voices: ['voice'] }] }

describe('voice settings request ownership', () => {
  it('hides results from an endpoint after its configuration changes', async () => {
    const test = Promise.withResolvers<{ ok: boolean; detail: string }>()
    const discovery = Promise.withResolvers<typeof models>()
    const dependencies = { testOpenAiConnection: () => test.promise, fetchOpenAiModels: () => discovery.promise }
    const { result, rerender } = renderHook((value) => useVoiceSettingsState(value, dependencies), {
      initialProps: config,
    })
    let pending: Promise<void>[]
    act(() => {
      pending = [result.current.runTest(), result.current.loadModels()]
    })
    rerender({ ...config, baseUrl: 'https://b.example/v1' })
    await act(async () => {
      test.resolve({ ok: true, detail: 'A works' })
      discovery.resolve(models)
      await Promise.all(pending)
    })
    expect(result.current.conn.status).toBe('idle')
    expect(result.current.models).toBeNull()
    expect(result.current.loadingModels).toBe(false)
  })

  it('keeps the newest test when requests complete out of order', async () => {
    const older = Promise.withResolvers<{ ok: boolean; detail: string }>()
    const testOpenAiConnection = mock()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(async () => ({ ok: false, detail: 'new failure' }))
    const { result } = renderHook(() =>
      useVoiceSettingsState(config, { testOpenAiConnection, fetchOpenAiModels: async () => models }),
    )
    let first: Promise<void>
    act(() => {
      first = result.current.runTest()
    })
    await act(async () => {
      await result.current.runTest()
    })
    await act(async () => {
      older.resolve({ ok: true, detail: 'old success' })
      await first
    })
    expect(result.current.conn).toEqual({ status: 'error', detail: 'new failure' })
  })
  it('tracks test and discovery independently and retains discovery across model/voice edits', async () => {
    const test = Promise.withResolvers<{ ok: boolean; detail: string }>()
    const discovery = Promise.withResolvers<typeof models>()
    const dependencies = { testOpenAiConnection: () => test.promise, fetchOpenAiModels: () => discovery.promise }
    const { result, rerender } = renderHook((value) => useVoiceSettingsState(value, dependencies), {
      initialProps: config,
    })
    const runs: Promise<void>[] = []
    act(() => {
      runs.push(result.current.runTest(), result.current.loadModels())
    })
    expect(result.current.conn.status).toBe('testing')
    expect(result.current.loadingModels).toBe(true)
    await act(async () => {
      discovery.resolve(models)
      await runs[1]
    })
    expect(result.current.conn.status).toBe('testing')
    expect(result.current.models).toEqual(models)
    expect(result.current.loadingModels).toBe(false)
    await act(async () => {
      test.resolve({ ok: true, detail: 'working' })
      await runs[0]
    })
    expect(result.current.conn.status).toBe('ok')
    rerender({ ...config, ttsVoice: 'new voice' })
    expect(result.current.conn.status).toBe('idle')
    expect(result.current.models).toEqual(models)
    rerender({ ...config, apiKey: 'replacement key' })
    expect(result.current.models).toBeNull()
  })

  it('keeps the newest discovery when an earlier discovery finishes later', async () => {
    const older = Promise.withResolvers<typeof models>()
    const fetchOpenAiModels = mock()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(async () => ({ stt: [], tts: [] }))
    const { result } = renderHook(() =>
      useVoiceSettingsState(config, {
        testOpenAiConnection: async () => ({ ok: true, detail: '' }),
        fetchOpenAiModels,
      }),
    )
    let first: Promise<void>
    act(() => {
      first = result.current.loadModels()
    })
    await act(() => result.current.loadModels())
    await act(async () => {
      older.resolve(models)
      await first
    })
    expect(result.current.models).toEqual({ stt: [], tts: [] })
    expect(result.current.loadingModels).toBe(false)
  })
})
