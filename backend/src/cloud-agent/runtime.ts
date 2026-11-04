/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { createModels, type MutableModels } from '@earendil-works/pi-ai'
import {
  Harness,
  configure,
  createRegistry,
  hook,
  ToolTask,
  watchEvents,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Extension,
  type Registry,
  type ToolRegistration,
  type Storage,
} from '@earendil-works/pi-durable'
import type { CloudAgentConfig, CloudMessageContent, CloudRunStatus } from '@shared/cloud-agent/contracts'
import type { AgentRow, RunRow } from './service'
import { createCloudModelProvider, type CloudModelCredentials } from './models'
import {
  ConversationBinding,
  RunBudget,
  RuntimeVersion,
  runtimeEngineVersion,
  createRuntimeCodec,
  isUncertainToolResult,
  projectEntry,
  reserveModelRequest,
  settleModelRequest,
} from './runtime-state'
import type { PostgresRuntimeStore } from './storage'
import { CloudError } from './errors'

export type LoadedCloudRun = {
  run: RunRow
  agent: AgentRow
  config: CloudAgentConfig & { model: NonNullable<CloudAgentConfig['model']> }
  key: CryptoKey
  text: string
  piConversationId: number | null
}
export type RuntimeHost = {
  loadRun: (runId: string) => Promise<LoadedCloudRun>
  setStatus: (runId: string, status: CloudRunStatus, errorCode?: string) => Promise<void>
  appendMessage: (runId: string, logicalId: string, content: CloudMessageContent) => Promise<void>
  beforeTool: (runId: string, callId: string, name: string, args: unknown, signal?: AbortSignal) => Promise<void>
  checkExecution: (runId: string) => Promise<void>
  settleCost: (runId: string, chargedMicros: number) => Promise<void>
  bindConversation: (runId: string, piId: number) => Promise<void>
  bindSubmission: (runId: string, piId: number) => Promise<void>
  activeRunIds: (agentId: string) => Promise<string[]>
  createTools: (
    loaded: LoadedCloudRun,
  ) => Promise<{ tools: ToolRegistration[]; instructions?: string; dispose?: () => Promise<void> }>
  resolveModel: (loaded: LoadedCloudRun) => Promise<CloudModelCredentials>
}
export type CloudRuntime = {
  run: (runId: string) => Promise<void>
  stop: (runId: string) => Promise<void>
  close: () => Promise<void>
}

type Binding = {
  loaded: LoadedCloudRun
  admission: ReturnType<typeof Promise.withResolvers<void>>
  extension: Extension
  environmentInstructions?: string
  dispose: () => Promise<void>
  conversation?: Conversation
  inputId?: EntryId
  failure?: string
}
type AgentRuntime = {
  harness: Harness
  registry: Registry
  models: MutableModels
  bindings: Map<string, Binding>
  users: number
  closing?: Promise<void>
}

/** Read the current turn through its immutable input marker, including entries compacted out of model context. */
const turnEntries = async (binding: Binding): Promise<EntryRecord[]> => {
  if (!binding.conversation) {
    throw new CloudError(409, 'conversation_not_bound')
  }
  const entries: EntryRecord[] = []
  const collect = async (cursor?: Parameters<Conversation['entries']>[2]): Promise<EntryRecord[]> => {
    const page = await binding.conversation!.entries({ order: 'descending' }, 100, cursor, BACKGROUND_CONTEXT)
    for (const entry of page.items) {
      if (entry.kind === 'thunderbolt.input') {
        if (
          typeof entry.data !== 'object' ||
          entry.data === null ||
          Array.isArray(entry.data) ||
          entry.data.runId !== binding.loaded.run.id
        ) {
          return entries.reverse()
        }
        binding.inputId = entry.id
        entries.push(entry)
        return entries.reverse()
      }
      entries.push(entry)
    }
    return page.next ? collect(page.next) : entries.reverse()
  }
  return collect()
}

const publicFailure = (error: unknown): string => (error instanceof CloudError ? error.code : 'runtime_failed')
const failedStatus = (code: string): CloudRunStatus =>
  code === 'tool_outcome_uncertain'
    ? 'uncertain'
    : code === 'run_stopped'
      ? 'stopped'
      : [
            'grant_revoked',
            'run_budget_exceeded',
            'step_limit_reached',
            'model_connection_disabled',
            'connection_authorization_expired',
            'approval_denied',
          ].includes(code)
        ? 'blocked'
        : 'failed'

/** One Bun process owns the store; lazily loaded agent harnesses share it and release plaintext state when idle. */
export const createCloudRuntime = (store: PostgresRuntimeStore, host: RuntimeHost): CloudRuntime => {
  const agents = new Map<string, Promise<AgentRuntime>>()
  const running = new Map<string, Promise<void>>()
  const closingSignal = new AbortController()
  const context = withAbortSignal(closingSignal.signal, BACKGROUND_CONTEXT)

  const project = async (binding: Binding, entries: readonly EntryRecord[]) => {
    for (const entry of entries) {
      if (
        entry.kind === 'thunderbolt.input' &&
        typeof entry.data === 'object' &&
        entry.data !== null &&
        !Array.isArray(entry.data) &&
        entry.data.runId === binding.loaded.run.id
      ) {
        binding.inputId = entry.id
      }
      if (binding.inputId === undefined || entry.id < binding.inputId) {
        continue
      }
      if (isUncertainToolResult(entry)) {
        binding.failure = 'tool_outcome_uncertain'
      }
      for (const message of projectEntry(entry)) {
        await host.appendMessage(binding.loaded.run.id, message.logicalId, message.content)
      }
    }
  }
  const admit = async (binding: Binding, signal?: AbortSignal) => {
    await awaitWithContext(binding.admission.promise, signal ? withAbortSignal(signal, context) : context)
    if (binding.failure) {
      throw new CloudError(409, binding.failure)
    }
    await host.checkExecution(binding.loaded.run.id)
  }

  const installBinding = async (
    state: Pick<AgentRuntime, 'registry' | 'models' | 'bindings'>,
    loaded: LoadedCloudRun,
    harness: () => Harness,
  ): Promise<Binding> => {
    const existing = state.bindings.get(loaded.run.id)
    if (existing) {
      return existing
    }
    const credentials = await host.resolveModel(loaded)
    const { tools, instructions: environmentInstructions, dispose = async () => {} } = await host.createTools(loaded)
    const binding: Binding = {
      loaded,
      admission: Promise.withResolvers<void>(),
      extension: { name: `cloud.run.${loaded.run.id}` },
      environmentInstructions,
      dispose,
    }
    const authorizeTool = async (callId: string, name: string, args: unknown, signal?: AbortSignal) => {
      try {
        await admit(binding, signal)
        await host.beforeTool(loaded.run.id, callId, name, args, signal)
        await host.checkExecution(loaded.run.id)
      } catch (error) {
        if (!closingSignal.signal.aborted && !signal?.aborted) {
          binding.failure = publicFailure(error)
        }
        throw error
      }
    }
    binding.extension = {
      name: binding.extension.name,
      hooks: [
        hook(ToolTask, {
          beforeTool: async (call, _api, callContext) => {
            await authorizeTool(call.id, call.name, call.arguments, callContext.abortSignal)
          },
        }),
      ],
      tools: tools.map((tool) => ({
        ...tool,
        execute: async (args, api, callContext) => {
          await authorizeTool(api.callId, tool.name, args, callContext.abortSignal)
          try {
            return await tool.execute(args, api, callContext)
          } catch (error) {
            if (!(error instanceof CloudError) || error.code !== 'tool_outcome_uncertain') {
              throw error
            }
            binding.failure = error.code
            // Persist the ambiguity in the tool result itself, so a restart cannot lose the stop decision.
            const message =
              'The tool was dispatched but its result could not be confirmed. Review the external system before retrying.'
            return {
              isError: true,
              output: [{ type: 'text', text: message }],
              diagnostics: [{ code: 'outcome_uncertain', severity: 'error', message }],
            }
          }
        },
      })),
    }
    const { provider } = createCloudModelProvider(loaded.run.id, loaded.config.model, credentials, {
      beforeRequest: async (transcript, signal) => {
        await admit(binding, signal)
        const entries = await turnEntries(binding)
        if (entries.some(isUncertainToolResult)) {
          binding.failure = 'tool_outcome_uncertain'
          throw new CloudError(409, binding.failure)
        }
        if (!binding.inputId) {
          throw new CloudError(409, 'run_input_missing')
        }
        return reserveModelRequest(harness(), loaded.run.id, loaded.config, credentials, transcript)
      },
      afterResponse: async (request, response) => {
        await settleModelRequest(harness(), loaded.run.id, request, response)
        if (response.stopReason === 'error' || response.stopReason === 'aborted') {
          binding.failure ??= 'model_request_failed'
        }
      },
      onError: (error) => {
        if (!closingSignal.signal.aborted) {
          binding.failure ??= publicFailure(error)
        }
      },
    })
    state.registry.install(binding.extension)
    state.models.setProvider(provider)
    state.bindings.set(loaded.run.id, binding)
    return binding
  }

  const openAgent = async (initial: LoadedCloudRun): Promise<AgentRuntime> => {
    const registry = createRegistry()
    const models = createModels()
    const bindings = new Map<string, Binding>()
    const holder: { harness?: Harness; storage?: Storage } = {}
    const getHarness = () => {
      if (!holder.harness) {
        throw new Error('Runtime harness is not open')
      }
      return holder.harness
    }
    try {
      // Restored tasks may start together. Their external dispatch remains gated by individual scheduler admission.
      for (const id of new Set([initial.run.id, ...(await host.activeRunIds(initial.agent.id))])) {
        const loaded = id === initial.run.id ? initial : await host.loadRun(id)
        if (loaded.run.keyEpoch !== initial.run.keyEpoch) {
          throw new CloudError(409, 'grant_revoked')
        }
        await installBinding({ registry, models, bindings }, loaded, getHarness)
      }
      const storage = await store.openNamespace(
        `agent:${initial.agent.id}`,
        createRuntimeCodec(initial.key, initial.run.userId, initial.agent.id, initial.run.keyEpoch),
      )
      holder.storage = storage
      holder.harness = await Harness.open(
        storage,
        {
          models,
          registry,
          settings: {
            extensions: [],
            retry: { enabled: false },
            compaction: { backgroundTokens: 0 },
            contextRetentionMs: 0,
            documentRetentionMs: 0,
            progress: { partialIntervalMs: 250, outputIntervalMs: 250 },
          },
        },
        context,
      )
      const version = await holder.harness.snapshot(RuntimeVersion, context)
      if (version && version.engine !== runtimeEngineVersion) {
        throw new CloudError(409, 'runtime_upgrade_required')
      }
      if (!version) {
        await holder.harness.commit(async (tx) => {
          await tx.doc(RuntimeVersion)
        }, context)
      }
      for (const binding of bindings.values()) {
        const mapping = await holder.harness.snapshot(ConversationBinding, binding.loaded.run.conversationId, context)
        if (mapping?.piId) {
          binding.conversation = await holder.harness.conversation(mapping.piId as ConversationId, context)
        }
      }
      return { harness: holder.harness, registry, models, bindings, users: 0 }
    } catch (error) {
      if (holder.harness) {
        await holder.harness.close(BACKGROUND_CONTEXT)
      } else if (holder.storage) {
        await holder.storage.close(BACKGROUND_CONTEXT)
      }
      await Promise.all([...bindings.values()].map((binding) => binding.dispose()))
      throw error
    }
  }

  const acquire = async (loaded: LoadedCloudRun): Promise<AgentRuntime> => {
    if (closingSignal.signal.aborted) {
      throw new Error('Cloud runtime is closing')
    }
    const current = agents.get(loaded.agent.id) ?? openAgent(loaded)
    agents.set(loaded.agent.id, current)
    try {
      const state = await current
      if (state.closing) {
        await state.closing
        return acquire(loaded)
      }
      state.users += 1
      return state
    } catch (error) {
      if (agents.get(loaded.agent.id) === current) {
        agents.delete(loaded.agent.id)
      }
      throw error
    }
  }
  const closeAgent = (agentId: string, state: AgentRuntime): Promise<void> => {
    if (state.closing) {
      return state.closing
    }
    state.closing = (async () => {
      try {
        await state.harness.close(BACKGROUND_CONTEXT)
      } finally {
        await Promise.all([...state.bindings.values()].map((binding) => binding.dispose()))
        agents.delete(agentId)
      }
    })()
    return state.closing
  }

  const execute = async (runId: string) => {
    const loaded = await host.loadRun(runId)
    await host.checkExecution(runId)
    await host.setStatus(runId, 'running')
    const state = await acquire(loaded)
    const holder: { binding?: Binding; settled: boolean } = { settled: false }
    try {
      const binding = await installBinding(state, loaded, () => state.harness)
      holder.binding = binding
      const piId = await state.harness.commit(async (tx) => {
        const mapping = await tx.doc(ConversationBinding, loaded.run.conversationId, null)
        if (mapping.piId === null) {
          mapping.piId = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id
        }
        await configure(tx, mapping.piId as ConversationId, {
          model: { provider: `cloud-${runId}`, modelId: loaded.config.model.modelId },
          extensions: [binding.extension],
          tools: binding.extension.tools,
          instructions: [
            loaded.config.instructions,
            ...loaded.config.skills.map((skill) => `## Skill: ${skill.name}\n${skill.instruction}`),
            binding.environmentInstructions,
          ]
            .filter(Boolean)
            .join('\n\n'),
        })
        return mapping.piId as ConversationId
      }, context)
      binding.conversation = await state.harness.conversation(piId, context)
      if (!binding.conversation) {
        throw new Error('Durable conversation is missing')
      }
      await host.bindConversation(runId, piId)
      const watch = await watchEvents(state.harness, piId, context)
      await project(binding, await turnEntries(binding))
      watch.start(async (events) => {
        for (const event of events) {
          if (event.type === 'snapshot') {
            await project(binding, event.entries)
          }
          if (event.type === 'entry_appended' || event.type === 'message_end') {
            await project(binding, [event.entry])
          }
        }
      })
      try {
        const submission = await binding.conversation.submit(
          {
            type: 'input',
            content: loaded.text,
            requestId: loaded.run.commandId,
            whenBusy: 'reject',
            entry: { kind: 'thunderbolt.input', data: { runId } },
          },
          context,
        )
        await host.bindSubmission(runId, submission.id)
        binding.admission.resolve()
        const result = await submission.wait(context)
        await project(binding, await turnEntries(binding))
        await host.checkExecution(runId)
        if (binding.failure) {
          throw new CloudError(409, binding.failure)
        }
        if (result.status !== 'done') {
          throw new CloudError(409, 'run_unanswered')
        }
        const budget = await state.harness.snapshot(RunBudget, runId, BACKGROUND_CONTEXT)
        await host.settleCost(runId, budget?.chargedMicros ?? 0)
        await host.setStatus(runId, 'completed')
        holder.settled = true
      } finally {
        await watch.stop()
      }
    } catch (error) {
      if (!closingSignal.signal.aborted) {
        // Storage and projection outages leave the durable turn resumable; only explicit execution failures settle it.
        if (!(error instanceof CloudError)) {
          throw error
        }
        const binding = holder.binding
        if (binding?.conversation) {
          await binding.conversation.abort(BACKGROUND_CONTEXT, { background: true })
          await project(binding, await turnEntries(binding))
        }
        const code = binding?.failure ?? publicFailure(error)
        const budget = await state.harness.snapshot(RunBudget, runId, BACKGROUND_CONTEXT)
        await host.settleCost(runId, budget?.chargedMicros ?? 0)
        await host.setStatus(runId, failedStatus(code), code)
        holder.settled = true
      }
    } finally {
      try {
        if (holder.settled && holder.binding) {
          state.bindings.delete(runId)
          state.models.deleteProvider(`cloud-${runId}`)
          state.registry.uninstall(holder.binding.extension)
          await holder.binding.dispose()
        }
      } finally {
        state.users -= 1
        if (state.users === 0) {
          await closeAgent(loaded.agent.id, state)
        }
      }
    }
  }

  return {
    run: (runId) => {
      const existing = running.get(runId)
      if (existing) {
        return existing
      }
      const task = execute(runId).finally(() => {
        running.delete(runId)
      })
      running.set(runId, task)
      return task
    },
    stop: async (runId) => {
      for (const pending of agents.values()) {
        const state = await pending
        const binding = state.bindings.get(runId)
        if (!binding) {
          continue
        }
        binding.failure = 'run_stopped'
        binding.admission.resolve()
        await binding.conversation?.abort(BACKGROUND_CONTEXT, { background: true })
      }
    },
    close: async () => {
      closingSignal.abort(new Error('Cloud runtime is closing'))
      await Promise.all([...agents].map(async ([id, pending]) => closeAgent(id, await pending)))
      await Promise.allSettled([...running.values()])
      await store.close()
    },
  }
}
