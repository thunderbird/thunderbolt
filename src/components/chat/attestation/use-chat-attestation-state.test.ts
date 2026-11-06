/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import * as tinfoilClients from '@/ai/tinfoil-client'
import { attestationStore } from '@/attestation/store'
import { tinfoilAttestationKey } from '@/attestation/target'
import { useChatStore } from '@/chats/chat-store'
import { useLocalSettingsStore } from '@/stores/local-settings-store'
import { createMockChatInstance, createMockModel, hydrateStore, resetStore } from '@/test-utils/chat-store-mocks'
import { createElement } from 'react'
import { ChatAttestation } from './chat-attestation'
import { useChatAttestationState } from './use-chat-attestation-state'
import { setupTestDatabase, resetTestDatabase, teardownTestDatabase } from '@/dal/test-utils'
import { createTestProvider } from '@/test-utils/test-provider'
import { renderWithReactivity, waitForElement } from '@/test-utils/powersync-reactivity-test'
import { updateSettings } from '@/dal'
import { getDb } from '@/db/database'

const model = createMockModel({ provider: 'tinfoil', isSystem: 1, isConfidential: 1 })
const managedKey = () => tinfoilAttestationKey('system', useLocalSettingsStore.getState().cloudUrl)

beforeAll(setupTestDatabase)
afterAll(teardownTestDatabase)
beforeEach(async () => {
  await resetTestDatabase()
  resetStore()
  attestationStore.clear(managedKey())
  attestationStore.clear('tinfoil:user')
  hydrateStore({
    id: 'privacy-chat',
    selectedModel: model,
    chatInstance: createMockChatInstance(),
    chatThread: null,
    triggerData: null,
  })
})
afterEach(() => {
  cleanup()
  resetStore()
  attestationStore.clear(managedKey())
  attestationStore.clear('tinfoil:user')
})

describe('chat attestation subscription', () => {
  it('renders verification time using the saved preference and follows changes while open', async () => {
    const verifiedAt = new Date(2026, 10, 6, 13, 30).getTime()
    const reporter = attestationStore.open(managedKey())
    reporter.publish({
      status: 'verified',
      evidence: { provider: 'Tinfoil', endpoint: 'router.tinfoil.sh', verifiedAt, checks: [], details: [] },
    })
    await updateSettings(getDb(), { time_format: '12h' })
    const { triggerChange } = renderWithReactivity(createElement(ChatAttestation), { tables: ['settings'] })
    fireEvent.click(screen.getByRole('button', { name: 'Connection privacy: Connection verified' }))
    await waitForElement(() => {
      const time = document.querySelector('time')
      return time?.textContent?.includes('1:30 PM') ? time : null
    })
    expect(document.querySelector('time')).toHaveTextContent('1:30 PM')
    expect(document.querySelector('time')).toHaveAttribute('datetime', new Date(verifiedAt).toISOString())

    await act(async () => {
      await updateSettings(getDb(), { time_format: '24h' })
      triggerChange(['settings'])
    })
    await waitForElement(() => {
      const time = document.querySelector('time')
      return time?.textContent?.includes('13:30') ? time : null
    })
    expect(document.querySelector('time')).toHaveTextContent('13:30')
    expect(document.querySelector('time')).not.toHaveTextContent('PM')
  })

  it.each([1, 0])('verifies the selected managed/BYOK transport only on demand (isSystem=%s)', async (isSystem) => {
    useChatStore.getState().updateSession('privacy-chat', { selectedModel: { ...model, isSystem } })
    const key = isSystem ? managedKey() : 'tinfoil:user'
    const reporter = attestationStore.open(key)
    reporter.publish({ status: 'idle' })
    const factory = spyOn(tinfoilClients, isSystem ? 'getSystemTinfoilClient' : 'getTinfoilClient').mockImplementation(
      async () => {
        reporter.publish({ status: 'failed', reason: 'verification' })
        throw new Error('SDK failure')
      },
    )
    try {
      const { result } = renderHook(useChatAttestationState, { wrapper: createTestProvider() })
      expect(factory).not.toHaveBeenCalled()
      expect(result.current.state.status).toBe('idle')
      await act(async () => {
        await result.current.verify()
      })
      expect(factory).toHaveBeenCalledTimes(1)
      expect(result.current.state).toEqual({ status: 'failed', reason: 'verification' })
    } finally {
      factory.mockRestore()
    }
  })

  it('drops local evidence as soon as the inference owner or selected transport changes', async () => {
    const reporter = attestationStore.open(managedKey())
    reporter.publish({
      status: 'verified',
      evidence: {
        provider: 'Tinfoil',
        endpoint: 'inference.tinfoil.sh',
        verifiedAt: 1,
        checks: ['hardware'],
        details: [],
      },
    })
    const { result } = renderHook(useChatAttestationState, { wrapper: createTestProvider() })
    expect(result.current.state.status).toBe('verified')
    act(() => useChatStore.getState().updateSession('privacy-chat', { selectedModel: { ...model, isSystem: 0 } }))
    expect(result.current.state.status).toBe('idle')
    const agent = useChatStore.getState().sessions.get('privacy-chat')!.selectedAgent
    act(() =>
      useChatStore.getState().updateSession('privacy-chat', { selectedAgent: { ...agent, type: 'remote-acp' } }),
    )
    expect(result.current.target?.kind).toBe('agent')
    await act(async () => {
      await result.current.verify()
    })
    expect(result.current.state.status).toBe('idle')
    act(() =>
      useChatStore.getState().updateSession('privacy-chat', {
        selectedAgent: agent,
        selectedModel: { ...model, provider: 'openai', isConfidential: 0 },
      }),
    )
    expect(result.current.target).toBeNull()
    await act(async () => {
      await result.current.verify()
    })
  })
  it('keeps remote privacy reachable without local model controls and resets on agent changes', () => {
    const session = useChatStore.getState().sessions.get('privacy-chat')!
    const remote = { ...session.selectedAgent, id: 'remote-one', type: 'remote-acp' as const, name: 'Remote one' }
    useChatStore.getState().updateSession('privacy-chat', { selectedAgent: remote })
    render(createElement(ChatAttestation), { wrapper: createTestProvider() })
    fireEvent.click(screen.getByRole('button', { name: 'Connection privacy: Agent privacy' }))
    expect(screen.getByText(/Remote one receives this chat/)).toBeVisible()
    act(() =>
      useChatStore
        .getState()
        .updateSession('privacy-chat', { selectedAgent: { ...remote, id: 'remote-two', name: 'Remote two' } }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Connection privacy: Agent privacy' }))
    expect(screen.getByText(/Remote two receives this chat/)).toBeVisible()
    act(() =>
      useChatStore.getState().updateSession('privacy-chat', {
        selectedAgent: session.selectedAgent,
        selectedModel: { ...model, provider: 'openai', isConfidential: 0 },
      }),
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
