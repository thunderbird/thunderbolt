/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { builtInAgent } from '@/defaults/agents'
import { createMockModel } from '@/test-utils/chat-store-mocks'
import type { Agent } from '@/types/acp'
import { describe, expect, it } from 'bun:test'
import { resolveSessionModel } from './resolve-session-model'

const confidential = createMockModel({ id: 'confidential', provider: 'tinfoil', isSystem: 1, isConfidential: 1 })
const missingKey = createMockModel({ id: 'missing-key', provider: 'openai', apiKey: null })
const standard = createMockModel({ id: 'standard', provider: 'thunderbolt' })
const models = [confidential, missingKey, standard]
const nonPrivateThread = { isEncrypted: 0 }

describe('resolveSessionModel', () => {
  it('takes the first model the picker enables for the thread, skipping one missing its API key', () => {
    expect(resolveSessionModel(builtInAgent, nonPrivateThread, confidential, models).id).toBe(standard.id)
  })

  it('leaves the model alone for an agent that does not use it', () => {
    const hostedAgent: Agent = { ...builtInAgent, id: 'hosted-agent', type: 'managed-http', transport: 'http' }
    expect(resolveSessionModel(hostedAgent, nonPrivateThread, confidential, models).id).toBe(confidential.id)
  })

  it('leaves the model alone for a chat with no thread row yet', () => {
    expect(resolveSessionModel(builtInAgent, null, confidential, models).id).toBe(confidential.id)
  })
})
