/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Run-spec propagation through `connectAcpAdapter`.
 *
 * The runner never picks a model: every session-establishing call AND every
 * prompt must carry the client's chosen gateway model id plus reasoning depth.
 * Skills travel under the same `_meta` namespace, so the interesting property
 * is that both survive together — a plain spread would drop one.
 *
 * Fully injected: a `FakeConnection` records the `_meta` of each call.
 */

import '@/testing-library'

import type {
  Agent as AcpSdkAgent,
  Client,
  InitializeRequest,
  LoadSessionRequest,
  NewSessionRequest,
  PromptRequest,
  ResumeSessionRequest,
} from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'bun:test'
import { readRunSpec, type RunSpec } from '@shared/acp-types'
import { readWireSkills, skillsCapabilityMeta, type SkillDefinition } from '@shared/agent-core/skills'
import type { Agent, AgentAdapterContext } from '@/types/acp'
import { connectAcpAdapter, type AcpAdapterContext } from './acp-adapter'
import type { AcpTransport } from './types'

const wireTarget: Agent = {
  id: '__thunderbolt-runner__',
  name: 'Thunderbolt',
  type: 'managed-acp',
  transport: 'websocket',
  url: 'wss://runner.test/ws',
  description: null,
  icon: null,
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
}

const runSpec: RunSpec = { modelId: 'thunderbolt/opus-mini', thinkingLevel: 'high' }

const skill: SkillDefinition = {
  name: 'summarize',
  description: 'Summarize a document',
  instruction: 'Be brief.',
}

const buildFakeTransport = (): AcpTransport => ({
  stream: { readable: new ReadableStream(), writable: new WritableStream() },
  close: () => {},
  closed: new Promise<void>(() => {}),
})

type FakeOptions = {
  /** Advertise wire-skills support so the adapter attaches skills metadata. */
  skills?: boolean
  resume?: boolean
  loadSession?: boolean
  rejectResume?: boolean
}

const buildFakeConnection = (opts: FakeOptions) => {
  const calls = {
    newSession: [] as NewSessionRequest[],
    resumeSession: [] as ResumeSessionRequest[],
    loadSession: [] as LoadSessionRequest[],
    prompt: [] as PromptRequest[],
  }

  class FakeConnection {
    constructor(toClient: (agent: AcpSdkAgent) => Client, _stream: AcpTransport['stream']) {
      toClient({} as AcpSdkAgent)
    }
    initialize = (_req: InitializeRequest) =>
      Promise.resolve({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: opts.loadSession ?? false,
          sessionCapabilities: opts.resume ? { resume: {} } : {},
          _meta: opts.skills ? skillsCapabilityMeta : undefined,
        },
      })
    newSession = (req: NewSessionRequest) => {
      calls.newSession.push(req)
      return Promise.resolve({ sessionId: 'sess-new' })
    }
    resumeSession = (req: ResumeSessionRequest) => {
      calls.resumeSession.push(req)
      return opts.rejectResume ? Promise.reject(new Error('evicted')) : Promise.resolve({})
    }
    loadSession = (req: LoadSessionRequest) => {
      calls.loadSession.push(req)
      return Promise.resolve({})
    }
    prompt = (req: PromptRequest) => {
      calls.prompt.push(req)
      return Promise.resolve({ stopReason: 'end_turn' })
    }
    extMethod = () => Promise.resolve({})
  }

  return { FakeConnection, calls }
}

const connect = async (opts: FakeOptions) => {
  const fake = buildFakeConnection(opts)
  const adapter = await connectAcpAdapter(
    wireTarget,
    { httpClient: {} as AcpAdapterContext['httpClient'] },
    {
      openTransport: async () => buildFakeTransport(),
      ClientSideConnection: fake.FakeConnection as never,
      textDeltaThrottleMs: 0,
      getEnabledSkills: async () => (opts.skills ? [skill] : []),
    },
  )
  return { adapter, ...fake }
}

const threadCtx = (overrides: Partial<AgentAdapterContext> = {}): AgentAdapterContext =>
  ({
    threadId: 't1',
    acpSessionId: null,
    onAcpSessionId: async () => {},
    runSpec,
    ...overrides,
  }) as AgentAdapterContext

const promptInit = (): RequestInit => ({
  method: 'POST',
  body: JSON.stringify({ messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
})

describe('connectAcpAdapter — run spec metadata', () => {
  it('attaches the run spec to session/new', async () => {
    const { adapter, calls } = await connect({})

    await adapter.ensureSession!(threadCtx())

    expect(readRunSpec(calls.newSession[0]._meta)).toEqual(runSpec)
  })

  it('attaches the run spec to session/resume', async () => {
    const { adapter, calls } = await connect({ resume: true })

    await adapter.ensureSession!(threadCtx({ acpSessionId: 'sess-stored' }))

    expect(readRunSpec(calls.resumeSession[0]._meta)).toEqual(runSpec)
    expect(calls.newSession).toHaveLength(0)
  })

  it('attaches the run spec to session/load when resume falls through', async () => {
    const { adapter, calls } = await connect({ resume: true, rejectResume: true, loadSession: true })

    await adapter.ensureSession!(threadCtx({ acpSessionId: 'sess-stored' }))

    expect(readRunSpec(calls.loadSession[0]._meta)).toEqual(runSpec)
  })

  it('attaches the run spec to session/prompt', async () => {
    const { adapter, calls } = await connect({})

    await adapter.fetch(promptInit(), threadCtx())

    expect(readRunSpec(calls.prompt[0]._meta)).toEqual(runSpec)
  })

  it('merges the run spec with skills instead of overwriting them', async () => {
    const { adapter, calls } = await connect({ skills: true })

    await adapter.ensureSession!(threadCtx())

    const meta = calls.newSession[0]._meta
    expect(readRunSpec(meta)).toEqual(runSpec)
    expect(readWireSkills(meta).map((s) => s.name)).toEqual(['summarize'])
  })

  it('omits _meta entirely for an agent that owns its own model and has no skills', async () => {
    const { adapter, calls } = await connect({})

    await adapter.ensureSession!(threadCtx({ runSpec: undefined }))

    expect(calls.newSession[0]._meta).toBeUndefined()
  })

  it('sends no run spec on prompt when the turn carries none', async () => {
    const { adapter, calls } = await connect({})

    await adapter.fetch(promptInit(), threadCtx({ runSpec: undefined }))

    expect(calls.prompt[0]._meta).toBeUndefined()
  })
})
