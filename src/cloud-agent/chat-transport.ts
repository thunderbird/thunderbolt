/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { i18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { ChatTransport, UIMessageChunk } from 'ai'
import type { CloudAgentRecord, CloudRun, SubmitCloudMessage } from '@shared/cloud-agent/contracts'
import type { ThunderboltUIMessage } from '@/types'
import { hydrateQuotesAsText } from '@/lib/quotes'
import { HttpError } from '@/lib/http'
import { extractLastUserText } from '@/skills/resolve-skill-system-messages'
import type { CloudAgentClient, CloudConversationView } from './client'
import { isCloudRunActive, latestCloudProjection } from './protocol'
import { cloudAssistantMessageId, cloudRecordChunks, cloudRunMetadata, cloudRunRecords } from './chat-projection'

export type CloudChatApproval = CloudConversationView['decryptedApprovals'][number]
type CloudChatClient = Pick<
  CloudAgentClient,
  'createConversation' | 'getConversation' | 'queuedMessage' | 'prepareMessage' | 'submitMessage' | 'stop' | 'decide'
>

export type CloudChatTransport = ChatTransport<ThunderboltUIMessage> & {
  load: (signal?: AbortSignal) => Promise<CloudConversationView>
  stop: () => Promise<void>
  dispose: () => void
}

/** Cloud failures never authorize a fresh model attempt; reconnecting reconciles the same durable command. */
export class CloudChatError extends Error {
  readonly retryable = false
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const terminalError = (run: CloudRun): CloudChatError | null => {
  if (run.status === 'uncertain') {
    return new CloudChatError(
      run.errorCode ?? run.status,
      i18n._(msg`The action outcome is unknown. Review the result before starting another run.`),
    )
  }
  if (run.status === 'failed' || run.status === 'blocked') {
    const code = run.errorCode ?? run.status
    return new CloudChatError(code, i18n._(msg`The cloud run needs attention (${code}).`))
  }
  return null
}

const projectionVersion = (view: CloudConversationView): string =>
  JSON.stringify([
    view.cursor,
    view.runs.map((run) => [run.id, run.status, run.updatedAt, run.errorCode]),
    view.approvals.map((approval) => [approval.id, approval.status]),
    view.messages.map((message) => [message.id, message.revision]),
  ])

const waitForPoll = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    }
  })

/** Poll server-owned durable runs through the normal AI SDK chat lifecycle, with explicit remote cancellation. */
export const createCloudChatTransport = ({
  client,
  agent,
  conversationId,
  getMessages,
  getApprovalMode,
  requestPermission,
  onProjection,
  pollIntervalMs = 2000,
}: {
  client: CloudChatClient
  agent: CloudAgentRecord
  conversationId: string
  getApprovalMode?: () => 'ask' | 'full-access'
  getMessages: () => readonly ThunderboltUIMessage[]
  requestPermission?: (approval: CloudChatApproval, signal: AbortSignal) => Promise<'approved' | 'denied' | null>
  onProjection?: (projection: CloudConversationView) => void | Promise<void>
  pollIntervalMs?: number
}): CloudChatTransport => {
  const state: { projection?: CloudConversationView; version?: string; disposed: boolean } = { disposed: false }
  const observers = new Set<AbortController>()
  const admissions = new Set<Promise<ReadableStream<UIMessageChunk>>>()
  const prepared = new Map<string, { text: string; submission: SubmitCloudMessage }>()
  const assertOpen = () => {
    if (state.disposed) {
      throw new DOMException('Cloud chat observation closed', 'AbortError')
    }
  }
  const load = async (signal?: AbortSignal) => {
    assertOpen()
    signal?.throwIfAborted()
    const incoming = await client.getConversation(agent, conversationId, signal)
    assertOpen()
    signal?.throwIfAborted()
    if (incoming.conversation.id !== conversationId || incoming.conversation.agentId !== agent.id) {
      throw new CloudChatError(
        'conversation_mismatch',
        i18n._(msg`This conversation belongs to a different cloud agent.`),
      )
    }
    const view = latestCloudProjection(state.projection, incoming)
    const version = projectionVersion(view)
    state.projection = view
    if (state.version !== version) {
      await onProjection?.(view)
      state.version = version
    }
    return view
  }
  const observe = (
    runId: string,
    initial: CloudConversationView | undefined,
    parentSignal?: AbortSignal,
  ): ReadableStream<UIMessageChunk> => {
    const observer = new AbortController()
    const abortFromParent = () => observer.abort(parentSignal?.reason)
    parentSignal?.addEventListener('abort', abortFromParent, { once: true })
    if (parentSignal?.aborted) {
      abortFromParent()
    }
    observers.add(observer)
    const existing = getMessages().at(-1)
    const resumed = existing?.id === cloudAssistantMessageId(runId) ? existing : undefined
    const seen = new Set(resumed?.metadata?.cloud?.recordIds ?? [])
    const tools = new Set(resumed?.parts.flatMap((part) => ('toolCallId' in part ? [part.toolCallId] : [])) ?? [])
    const approvals = new Map<string, AbortController>()
    const handledApprovals = new Set<string>()
    const streamState = { closed: false }
    const cleanup = () => {
      for (const pending of approvals.values()) {
        pending.abort()
      }
      approvals.clear()
      observers.delete(observer)
      parentSignal?.removeEventListener('abort', abortFromParent)
    }
    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        const fail = (error: unknown) => {
          if (streamState.closed) {
            return
          }
          streamState.closed = true
          if (observer.signal.aborted) {
            controller.enqueue({ type: 'abort' })
            controller.close()
          } else {
            controller.error(error)
          }
          observer.abort()
          cleanup()
        }
        const pollApprovals = (view: CloudConversationView) => {
          const pending = view.decryptedApprovals.filter(
            ({ record }) =>
              record.status === 'pending' &&
              view.runs.some((run) => run.id === record.runId && isCloudRunActive(run.status)),
          )
          for (const [id, active] of approvals) {
            if (!pending.some(({ record }) => record.id === id)) {
              active.abort()
              approvals.delete(id)
            }
          }
          if (!requestPermission || approvals.size) {
            return
          }
          for (const approval of pending) {
            if (handledApprovals.has(approval.record.id)) {
              continue
            }
            const active = new AbortController()
            approvals.set(approval.record.id, active)
            handledApprovals.add(approval.record.id)
            const decide = async () => {
              const decision = await requestPermission(approval, active.signal)
              if (!decision || active.signal.aborted || observer.signal.aborted) {
                return
              }
              await client.decide(approval.record.id, decision)
            }
            void decide().catch((error) => {
              if (!active.signal.aborted) {
                fail(error)
              }
            })
            break
          }
        }
        const pump = async () => {
          observer.signal.throwIfAborted()
          const first = initial ?? (await load(observer.signal))
          const firstRun = first.runs.find((run) => run.id === runId)
          if (!firstRun) {
            throw new CloudChatError('run_missing', i18n._(msg`The cloud run is no longer available.`))
          }
          controller.enqueue({
            type: 'start',
            messageId: cloudAssistantMessageId(runId),
            messageMetadata: cloudRunMetadata(first, firstRun, [...seen]),
          })
          const consume = (view: CloudConversationView): boolean => {
            const run = view.runs.find((value) => value.id === runId)
            if (!run) {
              throw new CloudChatError('run_missing', i18n._(msg`The cloud run is no longer available.`))
            }
            for (const record of cloudRunRecords(view, runId)) {
              if (record.content.role === 'user' || seen.has(record.record.id)) {
                continue
              }
              for (const chunk of cloudRecordChunks(record, tools)) {
                controller.enqueue(chunk)
              }
              seen.add(record.record.id)
              controller.enqueue({ type: 'message-metadata', messageMetadata: cloudRunMetadata(view, run, [...seen]) })
            }
            controller.enqueue({ type: 'message-metadata', messageMetadata: cloudRunMetadata(view, run, [...seen]) })
            if (isCloudRunActive(run.status)) {
              pollApprovals(view)
              return false
            }
            const error = terminalError(run)
            if (error) {
              controller.enqueue({ type: 'error', errorText: error.message })
            }
            controller.enqueue(run.status === 'stopped' ? { type: 'abort' } : { type: 'finish' })
            controller.close()
            streamState.closed = true
            cleanup()
            return true
          }
          if (consume(first)) {
            return
          }
          while (!observer.signal.aborted) {
            await waitForPoll(pollIntervalMs, observer.signal)
            const view = await load(observer.signal)
            if (consume(view)) {
              return
            }
          }
          observer.signal.throwIfAborted()
        }
        void pump().catch(fail)
      },
      cancel() {
        streamState.closed = true
        observer.abort()
        cleanup()
      },
    })
  }
  const verifyChat = (chatId: string) => {
    assertOpen()
    if (chatId !== conversationId) {
      throw new CloudChatError(
        'conversation_mismatch',
        i18n._(msg`This conversation belongs to a different cloud agent.`),
      )
    }
    if (observers.size) {
      throw new CloudChatError('already_observing', i18n._(msg`This cloud run is already being observed.`))
    }
  }
  const sendMessages = async ({ chatId, messages, abortSignal }: Parameters<CloudChatTransport['sendMessages']>[0]) => {
    verifyChat(chatId)
    abortSignal?.throwIfAborted()
    const user = messages.findLast((message) => message.role === 'user')
    if (!user) {
      throw new CloudChatError('prompt_missing', i18n._(msg`Enter a message for your cloud agent.`))
    }
    if (user.parts.some((part) => part.type === 'file' || part.type === 'data-attachment')) {
      throw new CloudChatError(
        'attachments_unsupported',
        i18n._(msg`Cloud agents cannot receive file attachments yet.`),
      )
    }
    const text = extractLastUserText(hydrateQuotesAsText([user])).trim()
    if (!text) {
      throw new CloudChatError('prompt_missing', i18n._(msg`Enter a message for your cloud agent.`))
    }
    await client.createConversation(agent.id, conversationId)
    const view = await load(abortSignal)
    const accepted = view.runs.find((run) => run.commandId === user.id)
    if (accepted) {
      const previous = cloudRunRecords(view, accepted.id).find(({ content }) => content.role === 'user')
      if (previous && previous.content.text.trim() !== text) {
        throw new CloudChatError(
          'command_payload_conflict',
          i18n._(msg`This message has already started a cloud run. Send a new message to change the request.`),
        )
      }
      return observe(accepted.id, view, abortSignal)
    }
    const queued = await client.queuedMessage(agent, conversationId)
    const pending = queued ?? prepared.get(user.id)
    if (pending && (pending.submission.commandId !== user.id || pending.text !== text)) {
      throw new CloudChatError(
        'queued_message_conflict',
        i18n._(msg`A different cloud message is still waiting to be sent. Review the queued message first.`),
      )
    }
    const command = pending ?? {
      text,
      submission: await client.prepareMessage(agent, text, user.id, getApprovalMode?.() ?? 'ask'),
    }
    prepared.set(user.id, command)
    assertOpen()
    abortSignal?.throwIfAborted()
    try {
      const run = await client.submitMessage(conversationId, command.submission)
      prepared.delete(user.id)
      return observe(run.id, undefined, abortSignal)
    } catch (error) {
      abortSignal?.throwIfAborted()
      const reconciled = await load(abortSignal).catch(() => undefined)
      const accepted = reconciled?.runs.find((run) => run.commandId === user.id)
      if (accepted) {
        prepared.delete(user.id)
        return observe(accepted.id, reconciled, abortSignal)
      }
      if (error instanceof HttpError && error.response.status === 422) {
        const body: unknown = await error.response.clone().json()
        if (body && typeof body === 'object' && 'error' in body && body.error === 'cloud_model_unavailable') {
          throw new CloudChatError(
            'cloud_model_unavailable',
            i18n._(
              msg`This agent's model is not connected in the cloud. Connect it in Settings, or start a new chat on this device.`,
            ),
          )
        }
      }
      throw error
    }
  }
  return {
    load,
    sendMessages: (options) => {
      const admission = sendMessages(options)
      admissions.add(admission)
      return admission.finally(() => admissions.delete(admission))
    },
    reconnectToStream: async ({ chatId }) => {
      verifyChat(chatId)
      const view = await load()
      const run = view.runs.findLast((candidate) => isCloudRunActive(candidate.status))
      return run ? observe(run.id, view) : null
    },
    stop: async () => {
      assertOpen()
      // Stop must follow admission; otherwise it can miss a prompt whose POST has not committed yet.
      await Promise.allSettled([...admissions])
      await client.stop(conversationId)
      for (const observer of observers) {
        observer.abort()
      }
    },
    dispose: () => {
      state.disposed = true
      for (const observer of observers) {
        observer.abort()
      }
    },
  }
}
