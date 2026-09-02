/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { Agent, Stream } from '@agentclientprotocol/sdk'
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core'
import type { Session as PiSession } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessage, Model, StopReason as PiStopReason } from '@earendil-works/pi-ai'
import type { PreparedPiBinding, ProviderRuntime } from '../provider-runtime/types.ts'
import type { ServeHarness } from './harness-agent.ts'
import type { SessionStore } from './session-store.ts'

/** Creates a minimal prepared binding with observable disposal. */
export const preparedBinding = (
  id: string,
  dispose: () => Promise<void> = async () => {},
): PreparedPiBinding => ({
  providerId: `profile-${id}`,
  wireModel: `wire-${id}`,
  persistsCredentialStatus: true,
  piModel: { provider: `profile-${id}`, id: `model-${id}` } as Model<Api>,
  install: () => {},
  attach: () => () => {},
  observePromptError: async () => {},
  dispose,
})

/** Creates a provider runtime fake whose only allowed ACP operation is prepare. */
export const providerRuntime = (
  prepare: ProviderRuntime['prepare'] = async () => preparedBinding('default'),
): ProviderRuntime => ({
  snapshot: () => {
    throw new Error('ACP sessions must not inspect provider manager state')
  },
  manage: async () => {
    throw new Error('ACP sessions must not mutate provider state outside prompt observation')
  },
  prepare,
})

/** Creates an in-memory ACP session store that records create and resume calls. */
export const fakeStore = (): SessionStore & {
  created: Array<{ id: string; cwd: string }>
  resumed: Array<{ id: string; cwd: string }>
} => {
  const repo = new InMemorySessionRepo()
  const byId = new Map<string, Promise<PiSession>>()
  const created: Array<{ id: string; cwd: string }> = []
  const resumed: Array<{ id: string; cwd: string }> = []
  const get = (id: string): Promise<PiSession> => {
    const existing = byId.get(id)
    if (existing) return existing
    const fresh = repo.create({ id })
    byId.set(id, fresh)
    return fresh
  }
  return {
    created,
    resumed,
    createSession: (id, cwd) => {
      created.push({ id, cwd })
      return get(id)
    },
    openSession: (id, cwd) => {
      resumed.push({ id, cwd })
      return get(id)
    },
  }
}

/** Creates a minimal valid assistant message for ACP harness tests. */
export const assistantMessage = (stopReason: PiStopReason = 'stop'): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'fake',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 0,
})

/** Creates a complete no-op ACP harness with targeted behavior overrides. */
export const fakeHarness = (overrides: Partial<ServeHarness> = {}): ServeHarness => ({
  subscribe: () => () => {},
  registerToolCallGate: () => {},
  prompt: async () => assistantMessage(),
  abort: async () => {},
  dispose: async () => {},
  ...overrides,
})

type AcpMessage = Stream['readable'] extends ReadableStream<infer Message> ? Message : never
type ControlledAgent = {
  readonly agent: Agent
  readonly close: () => void
  readonly closed: Promise<void>
}

/** Builds a real ACP connection whose incoming stream the test can close. */
export const controlledAgent = (factory: (connection: AgentSideConnection) => Agent): ControlledAgent => {
  let agent: Agent | null = null
  let close = (): void => {}
  const readable = new ReadableStream<AcpMessage>({
    start: (controller) => {
      close = () => controller.close()
    },
  })
  const writable = new WritableStream<AcpMessage>()
  const connection = new AgentSideConnection(
    (agentConnection) => {
      const created = factory(agentConnection)
      agent = created
      return created
    },
    { readable, writable },
  )
  if (!agent) throw new Error('Agent factory was not invoked')
  return { agent, close, closed: connection.closed }
}
