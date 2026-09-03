/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, test } from 'bun:test'
import { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { Agent, Stream } from '@agentclientprotocol/sdk'
import { InMemorySessionRepo } from '@earendil-works/pi-agent-core'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { bundledManagedCatalog } from './catalog.ts'
import { createHarnessAgent } from '../acp/harness-agent.ts'
import type { SessionStore } from '../acp/session-store.ts'
import { createHarnessRuntime } from '../agent/harness.ts'
import type { CommandSyntaxServeConfig, HarnessConfig } from '../agent/types.ts'
import type { CliDeviceMetadata } from '../auth/account-client.ts'
import { createProviderStageContext } from './provider-stage.ts'
import type { ProviderRuntimeDependencies } from './runtime.ts'
import { createTestProviderRuntime } from './test-fixtures.ts'
import type {
  ByokProfile,
  CliConfig,
  InvocationSelection,
  PreparedPiBinding,
  ProviderRuntime,
  ResolvedAccountCredential,
} from './types.ts'

const directModel = bundledManagedCatalog.data.find(({ isConfidential }) => isConfidential === 0)
if (!directModel) throw new Error('managed model fixtures require one direct model')

const byokProfile: ByokProfile = {
  id: 'work-profile',
  label: 'Work',
  provider: 'openai',
  defaultModel: 'test-model',
  apiKey: 'stored-key',
  credentialStatus: 'authenticated',
}
const sessionCredential: Extract<ResolvedAccountCredential, { type: 'session' }> = {
  type: 'session',
  backendUrl: 'https://api.example.com/v1',
  bearer: 'stored-session',
  deviceId: 'cli-00000000-0000-7000-8000-000000000001',
  userCacheSecret: new Uint8Array(32).fill(1),
}
const patCredential: Extract<ResolvedAccountCredential, { type: 'pat' }> = {
  type: 'pat',
  backendUrl: 'https://api.example.com/v1',
  token: 'environment-pat',
}
const metadata: CliDeviceMetadata = { deviceName: 'Parity Test CLI' }

type ParityProvenance = 'stored-byok' | 'flag' | 'environment' | 'stored-session' | 'pat'
type Deferred = { readonly promise: Promise<void>; readonly resolve: () => void }
type RuntimeProbe = {
  readonly runtime: ProviderRuntime
  readonly selection: InvocationSelection
  readonly saved: CliConfig[]
  readonly calls: {
    producer: number
    promptObservation: number
    sessionAuthenticationRequired: number
    dispose: number
  }
  readonly disposed: Promise<void>
}

/** Builds the persisted provider configuration for one credential provenance. */
const configFor = (provenance: ParityProvenance): CliConfig => ({
  version: 3,
  activeProviderId: provenance === 'stored-session' || provenance === 'pat' ? 'thunderbolt' : byokProfile.id,
  thunderbolt: { defaultModelId: directModel.id },
  providers: [byokProfile],
})

/** Builds the invocation selection for one credential provenance. */
const selectionFor = (provenance: ParityProvenance): InvocationSelection => {
  if (provenance === 'stored-session' || provenance === 'pat') {
    return { providerId: 'thunderbolt', model: directModel.id }
  }
  if (provenance === 'flag') return { providerId: byokProfile.id, apiKey: 'flag-key' }
  return { providerId: byokProfile.id }
}

/** Resolves the account credential used by managed provenance cases. */
const credentialFor = (provenance: ParityProvenance): ResolvedAccountCredential | null => {
  if (provenance === 'stored-session') return sessionCredential
  if (provenance === 'pat') return patCredential
  return null
}

/** Creates a faux binding whose synthetic message errors carry no HTTP evidence. */
const createObservedBinding = (
  ownerId: string,
  piModelId: string,
  provenance: ParityProvenance,
  calls: RuntimeProbe['calls'],
  disposed: Deferred,
): PreparedPiBinding => {
  const faux = fauxProvider({ provider: ownerId, models: [{ id: piModelId }] })
  faux.setResponses([
    fauxAssistantMessage('', {
      stopReason: 'error',
      errorMessage: 'OpenAI API error (401): expired credential',
    }),
    fauxAssistantMessage('recovered without replay'),
  ])
  return {
    providerId: ownerId,
    wireModel: piModelId,
    persistsCredentialStatus: provenance === 'stored-byok',
    piModel: faux.getModel(),
    install: (models) => models.setProvider(faux.provider),
    attach: () => () => {},
    observePromptError: async () => {
      calls.promptObservation += 1
    },
    dispose: async () => {
      calls.dispose += 1
      disposed.resolve()
    },
  }
}

/** Builds a real ProviderRuntime around observable binding producers and persistence. */
const createRuntimeProbe = async (provenance: ParityProvenance): Promise<RuntimeProbe> => {
  const saved: CliConfig[] = []
  const calls = { producer: 0, promptObservation: 0, sessionAuthenticationRequired: 0, dispose: 0 }
  const disposed = Promise.withResolvers<void>()
  const selection = selectionFor(provenance)
  const dependencies: ProviderRuntimeDependencies = {
    loadConfig: async () => configFor(provenance),
    loadAuthConfig: async () =>
      provenance === 'stored-session'
        ? {
            version: 2,
            backendUrl: sessionCredential.backendUrl,
            deviceId: sessionCredential.deviceId,
            userCacheSecret: Buffer.from(sessionCredential.userCacheSecret).toString('hex'),
            registration: 'registered',
            bearer: sessionCredential.bearer,
          }
        : null,
    saveConfig: async (next) => {
      saved.push(next)
    },
    resolveAccountCredential: async () => credentialFor(provenance),
    accountActions: {
      login: async () => ({
        version: 2,
        backendUrl: sessionCredential.backendUrl,
        deviceId: sessionCredential.deviceId,
        userCacheSecret: Buffer.from(sessionCredential.userCacheSecret).toString('hex'),
        registration: 'registered',
        bearer: sessionCredential.bearer,
      }),
      logout: async () => 'logged-out',
    },
    loadCatalog: async () => bundledManagedCatalog,
    ensureRegisteredSession: async (credential) => credential,
    markSessionAuthenticationRequired: async () => {
      calls.sessionAuthenticationRequired += 1
    },
    metadata,
    createByokBinding: async (profile, requested) => {
      calls.producer += 1
      return createObservedBinding(
        profile.id,
        requested.model ?? profile.defaultModel,
        provenance,
        calls,
        disposed,
      )
    },
    createManagedDirectBinding: async ({ credential, model }) => {
      calls.producer += 1
      return createObservedBinding(
        'thunderbolt',
        model.model,
        credential.type === 'session' ? 'stored-session' : 'pat',
        calls,
        disposed,
      )
    },
    createTinfoilBinding: async () => {
      throw new Error('parity fixture unexpectedly selected confidential inference')
    },
    environment: provenance === 'environment' ? { OPENAI_API_KEY: 'environment-key' } : {},
    providerStage: createProviderStageContext(),
  }
  const { runtime } = await createTestProviderRuntime(dependencies)
  return { runtime, selection, saved, calls, disposed: disposed.promise }
}

const harnessConfig: HarnessConfig = {
  cwd: process.cwd(),
  thinking: 'off',
}

/** Drives the direct path through the shared HarnessRuntime prompt observer. */
const runDirectPrompt = async (probe: RuntimeProbe): Promise<void> => {
  const binding = await probe.runtime.prepare(probe.selection)
  const harness = await createHarnessRuntime(harnessConfig, binding)
  try {
    expect((await harness.prompt('fail once')).stopReason).toBe('error')
  } finally {
    await harness.dispose()
  }
}

type AcpMessage = Stream['readable'] extends ReadableStream<infer Message> ? Message : never
type ControlledAgent = { readonly agent: Agent; readonly close: () => void; readonly closed: Promise<void> }

/** Builds a real ACP connection whose incoming stream the test can close. */
const controlledAgent = (factory: (connection: AgentSideConnection) => Agent): ControlledAgent => {
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

/** Creates an in-memory ACP session store for parity prompts. */
const inMemoryStore = (): SessionStore => {
  const repository = new InMemorySessionRepo()
  const sessions = new Map<string, ReturnType<InMemorySessionRepo['create']>>()
  return {
    createSession: (id) => {
      const session = repository.create({ id })
      sessions.set(id, session)
      return session
    },
    openSession: async (id) => {
      const session = sessions.get(id)
      if (!session) throw new Error(`missing session ${id}`)
      return session
    },
  }
}

/** Drives an error and recovery prompt through one live ACP session. */
const runAcpPrompts = async (probe: RuntimeProbe): Promise<void> => {
  const config: CommandSyntaxServeConfig = {
    ...harnessConfig,
    yolo: true,
    selection: probe.selection,
  }
  const controlled = controlledAgent((connection) =>
    createHarnessAgent(connection, config, inMemoryStore(), probe.runtime),
  )
  const { agent } = controlled
  const { sessionId } = await agent.newSession({ cwd: '/', mcpServers: [] })

  await expect(agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'fail once' }] })).rejects.toThrow(
    'expired credential',
  )
  expect((await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'still available' }] })).stopReason).toBe(
    'end_turn',
  )

  controlled.close()
  await controlled.closed
  await probe.disposed
}

/** Verifies synthetic message events never substitute for authenticated HTTP evidence. */
const expectNoEvidenceMutation = (probe: RuntimeProbe, provenance: ParityProvenance): void => {
  expect(probe.saved).toEqual([])
  expect(probe.calls.sessionAuthenticationRequired).toBe(0)
  if (provenance === 'stored-session') expect(probe.runtime.snapshot().thunderbolt.status).toBe('authenticated')
  else if (provenance === 'pat') expect(probe.runtime.snapshot().thunderbolt.status).toBe('not authenticated')
  else expect(probe.runtime.snapshot().providers[0]?.status).toBe('authenticated')
}

describe('direct and ACP ProviderRuntime parity', () => {
  for (const provenance of ['stored-byok', 'stored-session', 'flag', 'environment', 'pat'] as const) {
    test(`${provenance} ignores synthetic prompt status with identical direct/ACP behavior`, async () => {
      const direct = await createRuntimeProbe(provenance)
      await runDirectPrompt(direct)
      expect(direct.calls).toMatchObject({ producer: 1, promptObservation: 1, dispose: 1 })
      expectNoEvidenceMutation(direct, provenance)

      const acp = await createRuntimeProbe(provenance)
      await runAcpPrompts(acp)
      expect(acp.calls).toMatchObject({ producer: 1, promptObservation: 1, dispose: 1 })
      expectNoEvidenceMutation(acp, provenance)
    })
  }
})
