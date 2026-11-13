/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { builtInAgent } from '@/defaults/agents'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import type { Agent } from '@/types/acp'
import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { resolveSessionModel } from './resolve-session-model'
import { useLocalSettingsStore } from '@/stores/local-settings-store'

const confidential = createMockModel({ id: 'confidential', provider: 'tinfoil', isSystem: 1, isConfidential: 1 })
const missingKey = createMockModel({ id: 'missing-key', provider: 'openai', apiKey: null })
const standard = createMockModel({ id: 'standard', provider: 'thunderbolt' })
const models = [confidential, missingKey, standard]
const nonPrivateThread = { isEncrypted: 0 }

describe('resolveSessionModel', () => {
  let previous: ReturnType<typeof useLocalSettingsStore.getState>
  beforeEach(() => {
    previous = useLocalSettingsStore.getState()
    useLocalSettingsStore.setState({ cloudUrl: 'https://cloud.example.com/v1', localMode: false })
  })
  afterEach(() => useLocalSettingsStore.setState(previous))

  it('refreshes selected credentials from the current model list', () => {
    const refreshed = { ...standard, apiKey: 'rotated' }
    expect(resolveSessionModel(builtInAgent, null, standard, [refreshed])).toBe(refreshed)
  })

  it('replaces a removed model or one missing credentials with a usable model', () => {
    expect(resolveSessionModel(builtInAgent, null, missingKey, models)).toBe(confidential)
    expect(resolveSessionModel(builtInAgent, null, confidential, [standard])).toBe(standard)
  })

  it('does not select disabled or deleted candidates', () => {
    const disabled = { ...standard, id: 'disabled', enabled: 0 }
    const deleted = { ...standard, id: 'deleted', deletedAt: '2026-01-01' }
    expect(resolveSessionModel(builtInAgent, null, missingKey, [disabled, deleted, standard])).toBe(standard)
  })

  it('retains a placeholder when no model is usable so setup can be shown', () => {
    expect(resolveSessionModel(builtInAgent, null, standard, [])).toBe(standard)
  })

  it('replaces a managed selection with an own-key model when no server is connected', () => {
    useLocalSettingsStore.setState({ cloudUrl: '' })
    const local = createMockModel({
      provider: 'custom',
      isSystem: 0,
      isConfidential: 0,
      url: 'http://localhost:11434/v1',
    })
    expect(resolveSessionModel(builtInAgent, null, standard, [standard, local])).toBe(local)
  })

  it('retains the available selected model regardless of legacy thread privacy', () => {
    expect(resolveSessionModel(builtInAgent, nonPrivateThread, confidential, models).id).toBe(confidential.id)
  })

  it('leaves the model alone for an agent that does not use it', () => {
    const hostedAgent: Agent = { ...builtInAgent, id: 'hosted-agent', type: 'managed-http', transport: 'http' }
    expect(resolveSessionModel(hostedAgent, nonPrivateThread, confidential, models).id).toBe(confidential.id)
  })

  it('leaves the model alone for a chat with no thread row yet', () => {
    expect(resolveSessionModel(builtInAgent, null, confidential, models).id).toBe(confidential.id)
  })
})
