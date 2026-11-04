/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it, mock } from 'bun:test'
import { readUIMessageStream, type UIMessageChunk } from 'ai'
import type { CloudAgentRecord, CloudMessageContent, CloudRun, SubmitCloudMessage } from '@shared/cloud-agent/contracts'
import type { ThunderboltUIMessage } from '@/types'
import { getClock } from '@/testing-library'
import { HttpError } from '@/lib/http'
import type { CloudConversationView } from './client'
import { cloudConversationMessages } from './chat-projection'
import { createCloudChatTransport } from './chat-transport'

const ciphertext = { version: 1 as const, kind: 'scoped-payload' as const, iv: 'opaque', ciphertext: 'opaque' }
const agent: CloudAgentRecord = {
  id: 'agent',
  ownerId: 'owner',
  version: 1,
  keyEpoch: 1,
  enabled: true,
  config: ciphertext,
  ownerKeyEnvelope: {
    version: 1,
    kind: 'resource-key',
    recipientKeyId: 'owner',
    ephemeralPublicKey: 'opaque',
    mlkemCiphertext: 'opaque',
    iv: 'opaque',
    ciphertext: 'opaque',
  },
  createdAt: '2026-10-23T00:00:00Z',
  updatedAt: '2026-10-23T00:00:00Z',
  deletedAt: null,
}
const run = (status: CloudRun['status'], id = 'run', commandId = 'command'): CloudRun => ({
  id,
  commandId,
  conversationId: 'conversation',
  configVersion: 1,
  status,
  errorCode: null,
  createdAt: '2026-10-23T00:00:00Z',
  updatedAt: '2026-10-23T00:00:00Z',
})
const message = (sequence: number, content: CloudMessageContent, runId = 'run') => ({
  record: {
    id: `${runId}:message:${sequence}`,
    conversationId: 'conversation',
    runId,
    sequence,
    revision: 1,
    keyEpoch: 1,
    content: ciphertext,
    createdAt: '2026-10-23T00:00:00Z',
  },
  content,
})
const view = (
  runs: CloudRun[] = [],
  decryptedMessages: CloudConversationView['decryptedMessages'] = [],
): CloudConversationView => ({
  conversation: {
    id: 'conversation',
    agentId: 'agent',
    ownerId: 'owner',
    createdAt: '2026-10-23T00:00:00Z',
    updatedAt: '2026-10-23T00:00:00Z',
    deletedAt: null,
  },
  runs,
  decryptedMessages,
  messages: decryptedMessages.map(({ record }) => record),
  approvals: [],
  decryptedApprovals: [],
  cursor: Math.max(0, ...decryptedMessages.map(({ record }) => record.sequence)),
})
const user: ThunderboltUIMessage = { id: 'command', role: 'user', parts: [{ type: 'text', text: 'Task' }] }
const prompt = message(1, { role: 'user', text: 'Task' })
const answer = message(2, { role: 'assistant', text: 'Actual model answer' })
const submission: SubmitCloudMessage = { commandId: user.id, keyEpoch: 1, content: ciphertext }

const fixture = (views: CloudConversationView[]) => {
  const queue = [...views]
  const state = { latest: views[0] ?? view() }
  const client = {
    createConversation: mock(async () => state.latest.conversation),
    getConversation: mock(async () => {
      state.latest = queue.shift() ?? state.latest
      return state.latest
    }),
    queuedMessage: mock(async (): Promise<{ text: string; submission: SubmitCloudMessage } | null> => null),
    prepareMessage: mock(
      async (
        _agent: CloudAgentRecord,
        _text: string,
        commandId?: string,
        _approvalMode?: 'ask' | 'full-access',
      ): Promise<SubmitCloudMessage> => ({
        ...submission,
        commandId: commandId ?? 'random',
      }),
    ),
    submitMessage: mock(async (_conversationId: string, _submission: SubmitCloudMessage) => run('queued')),
    stop: mock(async () => ({})),
    decide: mock(async (_id: string, _decision: 'approved' | 'denied') => ({})),
  }
  return { client, queue, state }
}
const send = (
  transport: ReturnType<typeof createCloudChatTransport>,
  changes: Partial<Parameters<typeof transport.sendMessages>[0]> = {},
) =>
  transport.sendMessages({
    chatId: 'conversation',
    trigger: 'submit-message',
    messageId: undefined,
    messages: [user],
    abortSignal: undefined,
    ...changes,
  })
const chunks = async (stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> => {
  const result: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const next = await reader.read()
    if (next.done) {
      return result
    }
    result.push(next.value)
  }
}
const finish = async <T>(result: Promise<T>): Promise<T> => {
  await getClock().runAllAsync()
  return result
}

describe('cloud normal-chat transport', () => {
  it('explains a missing cloud model after confirming that no run was admitted', async () => {
    const f = fixture([view()])
    f.client.submitMessage.mockRejectedValue(
      new HttpError(Response.json({ error: 'cloud_model_unavailable' }, { status: 422 })),
    )
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
    })
    await expect(send(transport)).rejects.toMatchObject({ code: 'cloud_model_unavailable', retryable: false })
    expect(f.client.submitMessage).toHaveBeenCalledTimes(1)
  })
  it('submits the composer command once and emits real committed model text without repeated poll output', async () => {
    const active = view([run('running')], [prompt, answer])
    const f = fixture([view(), active, active, view([run('completed')], [prompt, answer])])
    const onProjection = mock(() => {})
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
      onProjection,
      pollIntervalMs: 1,
    })
    const output = await finish(chunks(await send(transport)))
    expect(f.client.prepareMessage.mock.calls[0]).toEqual([agent, 'Task', 'command', 'ask'])
    expect(f.client.submitMessage).toHaveBeenCalledTimes(1)
    expect(output.filter((part) => part.type === 'text-delta')).toEqual([
      { type: 'text-delta', id: answer.record.id, delta: 'Actual model answer' },
    ])
    expect(output.at(-1)).toEqual({ type: 'finish' })
    expect(onProjection).toHaveBeenCalledTimes(3)
  })

  it('captures the chat approval choice when preparing a new durable command', async () => {
    const f = fixture([view(), view([run('completed')], [prompt, answer])])
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
      getApprovalMode: () => 'full-access',
      pollIntervalMs: 1,
    })
    await finish(chunks(await send(transport)))
    expect(f.client.prepareMessage.mock.calls[0]?.[3]).toBe('full-access')
  })

  it('reconciles a lost accepted response by command ID without submitting or preparing a second attempt', async () => {
    const f = fixture([view(), view([run('completed')], [prompt, answer])])
    f.client.submitMessage.mockRejectedValueOnce(new TypeError('Response lost'))
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
    })
    const output = await chunks(await send(transport))
    expect(output.some((part) => part.type === 'text-delta' && part.delta === 'Actual model answer')).toBe(true)
    expect(f.client.prepareMessage).toHaveBeenCalledTimes(1)
    expect(f.client.submitMessage).toHaveBeenCalledTimes(1)
  })

  it('reuses persisted ciphertext after reload and refuses a different queued prompt', async () => {
    const f = fixture([view(), view([run('completed')], [prompt, answer])])
    f.client.queuedMessage.mockResolvedValue({ text: 'Task', submission })
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
    })
    await chunks(await send(transport, { trigger: 'regenerate-message' }))
    expect(f.client.prepareMessage).not.toHaveBeenCalled()
    expect(f.client.submitMessage.mock.calls[0]).toEqual(['conversation', submission])
    const other = fixture([view()])
    other.client.queuedMessage.mockResolvedValue({
      text: 'Different',
      submission: { ...submission, commandId: 'other' },
    })
    const conflict = createCloudChatTransport({
      ...other,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
    })
    await expect(send(conflict)).rejects.toMatchObject({ code: 'queued_message_conflict' })
    expect(other.client.submitMessage).not.toHaveBeenCalled()
  })

  it('resumes a hydrated assistant through the real SDK without duplicating already-rendered text', async () => {
    const partial = view([run('running')], [prompt, answer])
    const final = message(3, { role: 'assistant', text: 'Final paragraph' })
    const f = fixture([partial, view([run('completed')], [prompt, answer, final])])
    const messages = cloudConversationMessages(partial)
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => messages,
      pollIntervalMs: 1,
    })
    const stream = await transport.reconnectToStream({ chatId: 'conversation' })
    expect(stream).not.toBeNull()
    const read = async () => {
      const rendered: ThunderboltUIMessage[] = []
      for await (const update of readUIMessageStream<ThunderboltUIMessage>({
        message: messages.at(-1),
        stream: stream!,
        terminateOnError: true,
      })) {
        rendered.push(structuredClone(update))
      }
      return rendered.at(-1)!
    }
    const result = await finish(read())
    expect(result.id).toBe('cloud-run:run')
    expect(result.parts.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
      'Actual model answer',
      'Final paragraph',
    ])
    expect(result.metadata?.cloud?.recordIds).toEqual([answer.record.id, final.record.id])
    expect(f.client.submitMessage).not.toHaveBeenCalled()
    expect(f.client.prepareMessage).not.toHaveBeenCalled()
  })

  it('pairs parallel same-name tools by real call ID in live and hydrated ordinary messages', async () => {
    const calls = message(2, {
      role: 'assistant',
      text: 'Checking both records.',
      toolCalls: [
        { id: 'call-a', name: 'lookup', arguments: { record: 'a' } },
        { id: 'call-b', name: 'lookup', arguments: { record: 'b' } },
      ],
    })
    const resultB = message(3, { role: 'tool', toolName: 'lookup', toolCallId: 'call-b', text: '{"result":"b"}' })
    const resultA = message(4, {
      role: 'tool',
      toolName: 'lookup',
      toolCallId: 'call-a',
      text: 'Permission denied',
      toolError: true,
    })
    const completed = view(
      [run('completed')],
      [prompt, calls, resultB, resultA, message(5, { role: 'assistant', text: 'B was available.' })],
    )
    const f = fixture([completed])
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
    })
    const rendered: ThunderboltUIMessage[] = []
    for await (const update of readUIMessageStream<ThunderboltUIMessage>({
      stream: await send(transport),
      terminateOnError: true,
    })) {
      rendered.push(update)
    }
    for (const result of [rendered.at(-1)!, cloudConversationMessages(completed).at(-1)!]) {
      const tools = result.parts.filter((part) => part.type === 'dynamic-tool')
      expect(tools).toHaveLength(2)
      expect(tools[0]).toMatchObject({
        toolCallId: 'call-a',
        input: { record: 'a' },
        state: 'output-error',
        errorText: 'Permission denied',
      })
      expect(tools[1]).toMatchObject({
        toolCallId: 'call-b',
        input: { record: 'b' },
        state: 'output-available',
        output: { result: 'b' },
      })
      expect(result.parts.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
        'Checking both records.',
        'B was available.',
      ])
    }
  })

  it('dismisses an obsolete approval when another device finishes the run without submitting a local decision', async () => {
    const initial = view([run('awaiting-approval')], [prompt])
    initial.decryptedApprovals = [
      {
        record: {
          id: 'approval',
          runId: 'run',
          agentId: 'agent',
          keyEpoch: 1,
          status: 'pending',
          payload: ciphertext,
          createdAt: run('running').createdAt,
        },
        payload: { toolName: 'write', arguments: { value: 'sensitive' } },
      },
    ]
    initial.approvals = initial.decryptedApprovals.map(({ record }) => record)
    const f = fixture([initial, view([run('completed')], [prompt, answer])])
    const signals: AbortSignal[] = []
    const requestPermission = mock(async (_approval: unknown, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }))
    })
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
      requestPermission,
      pollIntervalMs: 1,
    })
    await finish(
      chunks((await transport.reconnectToStream({ chatId: 'conversation' })) as ReadableStream<UIMessageChunk>),
    )
    expect(signals[0]!.aborted).toBe(true)
    expect(requestPermission).toHaveBeenCalledTimes(1)
    expect(f.client.decide).not.toHaveBeenCalled()
    expect(f.client.stop).not.toHaveBeenCalled()
  })

  it('returns terminal uncertainty for manual retry instead of starting another model/tool run', async () => {
    const terminal = { ...run('uncertain'), errorCode: 'tool_outcome_uncertain' }
    const f = fixture([view([terminal], [prompt, answer])])
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
    })
    const output = await chunks(await send(transport, { trigger: 'regenerate-message' }))
    expect(output.some((part) => part.type === 'error' && part.errorText.includes('outcome is unknown'))).toBe(true)
    expect(f.client.submitMessage).not.toHaveBeenCalled()
    expect(f.client.prepareMessage).not.toHaveBeenCalled()
    await expect(
      send(transport, { messages: [{ ...user, parts: [{ type: 'text', text: 'Changed prompt' }] }] }),
    ).rejects.toMatchObject({ code: 'command_payload_conflict' })
  })

  it('does not publish a late read after the chat binding is disposed', async () => {
    const f = fixture([view()])
    const pending = Promise.withResolvers<CloudConversationView>()
    f.client.getConversation.mockReturnValueOnce(pending.promise)
    const onProjection = mock(() => {})
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [],
      onProjection,
    })
    const loading = transport.load()
    transport.dispose()
    pending.resolve(view([run('running')], [prompt]))
    await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    expect(onProjection).not.toHaveBeenCalled()
    expect(f.client.stop).not.toHaveBeenCalled()
  })

  it('detaches on dispose, and only explicit Stop cancels the server run', async () => {
    const f = fixture([view([run('running')], [prompt])])
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
    })
    const reading = chunks(
      (await transport.reconnectToStream({ chatId: 'conversation' })) as ReadableStream<UIMessageChunk>,
    )
    transport.dispose()
    expect((await reading).at(-1)).toEqual({ type: 'abort' })
    expect(f.client.stop).not.toHaveBeenCalled()
    const stopped = createCloudChatTransport({ ...f, agent, conversationId: 'conversation', getMessages: () => [user] })
    const output = chunks(
      (await stopped.reconnectToStream({ chatId: 'conversation' })) as ReadableStream<UIMessageChunk>,
    )
    await stopped.stop()
    expect((await output).at(-1)).toEqual({ type: 'abort' })
    expect(f.client.stop).toHaveBeenCalledTimes(1)
  })

  it('orders immediate Stop after the pending submission is acknowledged', async () => {
    const f = fixture([view(), view([run('running')], [prompt])])
    const admitted = Promise.withResolvers<CloudRun>()
    f.client.submitMessage.mockReturnValueOnce(admitted.promise)
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => [user],
    })
    const sending = send(transport)
    const stopping = transport.stop()
    await Promise.resolve()
    expect(f.client.stop).not.toHaveBeenCalled()
    admitted.resolve(run('running'))
    const stream = await sending
    const output = chunks(stream)
    await stopping
    expect(f.client.submitMessage).toHaveBeenCalledTimes(1)
    expect(f.client.stop).toHaveBeenCalledTimes(1)
    expect((await output).at(-1)).toEqual({ type: 'abort' })
  })

  it('services earlier-run approvals one at a time while observing a later queued turn', async () => {
    const first = run('awaiting-approval')
    const second = run('queued', 'later', 'later-command')
    const initial = view([first, second], [prompt, message(2, { role: 'user', text: 'Later task' }, 'later')])
    initial.decryptedApprovals = ['approval-1', 'approval-2'].map((id) => ({
      record: {
        id,
        runId: first.id,
        agentId: agent.id,
        keyEpoch: 1,
        status: 'pending',
        payload: ciphertext,
        createdAt: first.createdAt,
      },
      payload: { toolName: 'write', arguments: { id } },
    }))
    initial.approvals = initial.decryptedApprovals.map(({ record }) => record)
    const f = fixture([initial])
    const decisions: string[] = []
    f.client.decide.mockImplementation(async (id: string) => {
      decisions.push(id)
      initial.decryptedApprovals = initial.decryptedApprovals.map((approval) =>
        approval.record.id === id ? { ...approval, record: { ...approval.record, status: 'approved' } } : approval,
      )
      initial.approvals = initial.decryptedApprovals.map(({ record }) => record)
      if (decisions.length === 2) {
        initial.runs = initial.runs.map((value) => ({ ...value, status: 'completed' }))
      }
      return {}
    })
    const requestPermission = mock(async (_approval: unknown, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false)
      return 'approved' as const
    })
    const transport = createCloudChatTransport({
      ...f,
      agent,
      conversationId: 'conversation',
      getMessages: () => cloudConversationMessages(initial),
      requestPermission,
      pollIntervalMs: 1,
    })
    const result = await finish(
      chunks((await transport.reconnectToStream({ chatId: 'conversation' })) as ReadableStream<UIMessageChunk>),
    )
    expect(result[0]).toMatchObject({ type: 'start', messageId: 'cloud-run:later' })
    expect(decisions).toEqual(['approval-1', 'approval-2'])
    expect(requestPermission).toHaveBeenCalledTimes(2)
    expect(f.client.submitMessage).not.toHaveBeenCalled()
  })
})
