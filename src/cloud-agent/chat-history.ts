/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { eq, inArray } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { chatMessagesTable, chatThreadsTable } from '@/db/tables'
import { getOrCreateChatThread, updateChatThread } from '@/dal/chat-threads'
import { saveStreamingAssistantMessage } from '@/dal/chat-messages'
import { getSelectedModel } from '@/dal/models'
import { useChatStore } from '@/chats/chat-store'
import { isCloudAgent } from '@/defaults/agents'
import { defaultChatTitle } from '@/lib/constants'
import { generateTitle, titleSourceText } from '@/lib/title-generator'
import type { ChatThread, ThunderboltUIMessage, UIMessageMetadata } from '@/types'
import type { CloudAgentClient, CloudAgentView, CloudConversationView } from './client'
import { cloudAgentSelectionId } from './agent-inventory'
import { cloudConversationMessages } from './chat-projection'
import { isCloudRunActive } from './protocol'

/** Restore durable turn order when ordinary SQLite reads have sorted random cloud IDs lexicographically. */
export const sortCloudChatMessages = <T extends { metadata?: UIMessageMetadata | null }>(messages: T[]): T[] =>
  messages.toSorted(
    (left, right) =>
      (left.metadata?.cloud?.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.metadata?.cloud?.sequence ?? Number.MAX_SAFE_INTEGER),
  )

/** A live transport owns its current reply; background imports retry it after completion. */
export const cloudChatIsBusy = (id: string): boolean => {
  const status = useChatStore.getState().sessions.get(id)?.chatInstance.status
  return status === 'streaming' || status === 'submitted'
}

const reconnecting = new WeakSet<object>()

/** Resume observation once per live instance; reconnecting awaits the server before the SDK marks itself busy. */
export const resumeCloudChat = (id: string): void => {
  const session = useChatStore.getState().sessions.get(id)
  if (
    !session ||
    !isCloudAgent(session.selectedAgent) ||
    !session.selectedAgent.enabled ||
    session.stopping ||
    cloudChatIsBusy(id) ||
    reconnecting.has(session.chatInstance) ||
    session.chatInstance.messages.some((message) => message.role === 'user' && !message.metadata?.cloud)
  ) {
    return
  }
  const instance = session.chatInstance
  reconnecting.add(instance)
  const resume = async () => {
    try {
      await instance.resumeStream()
    } catch {
      console.error('Cloud chat reconnect failed; history will refresh again.')
    } finally {
      reconnecting.delete(instance)
    }
  }
  void resume()
}

/** Refresh only this owner's idle instance, keeping locally queued prompts until the server acknowledges their IDs. */
const refreshCloudChat = (
  agent: CloudAgentView,
  view: CloudConversationView,
  thread: ChatThread,
  messages: ThunderboltUIMessage[],
): void => {
  const store = useChatStore.getState()
  const session = store.sessions.get(thread.id)
  if (
    !session ||
    cloudChatIsBusy(thread.id) ||
    session.selectedAgent.id !== thread.agentId ||
    session.selectedAgent.userId !== agent.record.ownerId
  ) {
    return
  }
  const acknowledged = new Set(messages.map((message) => message.id))
  const pending = session.chatInstance.messages.filter(
    (message) => message.role === 'user' && !message.metadata?.cloud && !acknowledged.has(message.id),
  )
  session.chatInstance.messages = [...messages, ...pending]
  store.updateSession(thread.id, { chatThread: thread })
  if (agent.record.enabled && view.runs.some((run) => isCloudRunActive(run.status))) {
    resumeCloudChat(thread.id)
  }
}

/** Persist an authenticated cloud projection through the ordinary encrypted chat DAL, without restoring deleted data. */
export const persistCloudConversation = async (
  db: AnyDrizzleDatabase,
  agent: CloudAgentView,
  view: CloudConversationView,
): Promise<ChatThread | null> => {
  const conversation = view.conversation
  if (
    conversation.ownerId !== agent.record.ownerId ||
    conversation.agentId !== agent.record.id ||
    conversation.deletedAt ||
    agent.record.deletedAt ||
    cloudChatIsBusy(conversation.id)
  ) {
    return null
  }
  const agentId = cloudAgentSelectionId(agent.record.id)
  const messages = sortCloudChatMessages(cloudConversationMessages(view))
  const persisted = await db.transaction(async (tx) => {
    const existing = await tx.select().from(chatThreadsTable).where(eq(chatThreadsTable.id, conversation.id)).get()
    if (
      existing &&
      (existing.deletedAt ||
        existing.agentId !== agentId ||
        (existing.userId && existing.userId !== conversation.ownerId))
    ) {
      return null
    }
    const storedMessages = messages.length
      ? await tx
          .select()
          .from(chatMessagesTable)
          .where(
            inArray(
              chatMessagesTable.id,
              messages.map((message) => message.id),
            ),
          )
      : []
    if (
      storedMessages.some((message) => message.chatThreadId !== conversation.id) ||
      cloudChatIsBusy(conversation.id)
    ) {
      return null
    }
    const stored = new Map(storedMessages.map((message) => [message.id, message]))
    const thread = existing
      ? (existing as ChatThread)
      : await getOrCreateChatThread(tx, conversation.id, (await getSelectedModel(tx)).id, { agentId, isEncrypted: 0 })
    const firstUser = messages.find((message) => message.role === 'user')
    const titleSource = firstUser ? titleSourceText(firstUser) : ''
    const title =
      (!existing || thread.title === defaultChatTitle) && titleSource ? generateTitle(titleSource) : thread.title
    if (title !== thread.title) {
      await updateChatThread(tx, conversation.id, { title })
    }
    for (const [index, message] of messages.entries()) {
      if (cloudChatIsBusy(conversation.id)) {
        return null
      }
      const previous = stored.get(message.id)
      if (previous?.deletedAt) {
        continue
      }
      if (
        previous &&
        previous.role === message.role &&
        JSON.stringify(previous.parts) === JSON.stringify(message.parts) &&
        JSON.stringify(previous.metadata ?? {}) === JSON.stringify(message.metadata ?? {})
      ) {
        continue
      }
      await saveStreamingAssistantMessage(tx, conversation.id, message, index === 0 ? null : messages[index - 1].id)
    }
    return { thread: { ...thread, title }, messages: messages.filter((message) => !stored.get(message.id)?.deletedAt) }
  })
  if (!persisted) {
    return null
  }
  refreshCloudChat(agent, view, persisted.thread, persisted.messages)
  return persisted.thread
}

/** Import a bounded batch in sequence; successful unchanged conversations need no repeated transcript download. */
export const createCloudChatHistoryImporter = (
  db: AnyDrizzleDatabase,
  client: Pick<CloudAgentClient, 'conversations' | 'getConversation'>,
  maxPerPass = 20,
) => {
  const state = { offset: 0, imported: new Map<string, string>() }
  return async (agents: CloudAgentView[], signal?: AbortSignal) => {
    const candidates: { agent: CloudAgentView; id: string; updatedAt: string }[] = []
    for (const agent of agents) {
      if (signal?.aborted) {
        return
      }
      for (const conversation of await client.conversations(agent.record.id, signal)) {
        if (
          conversation.ownerId === agent.record.ownerId &&
          conversation.agentId === agent.record.id &&
          !conversation.deletedAt
        ) {
          candidates.push({ agent, id: conversation.id, updatedAt: conversation.updatedAt })
        }
      }
    }
    if (!candidates.length) {
      return
    }
    const start = state.offset % candidates.length
    const count = Math.min(maxPerPass, candidates.length)
    state.offset = (start + count) % candidates.length
    for (const index of Array.from({ length: count }, (_, index) => (start + index) % candidates.length)) {
      if (signal?.aborted) {
        return
      }
      const candidate = candidates[index]
      if (state.imported.get(candidate.id) === candidate.updatedAt || cloudChatIsBusy(candidate.id)) {
        continue
      }
      const view = await client.getConversation(candidate.agent.record, candidate.id, signal)
      if (signal?.aborted) {
        return
      }
      if (await persistCloudConversation(db, candidate.agent, view)) {
        if (!view.runs.some((run) => isCloudRunActive(run.status))) {
          state.imported.set(candidate.id, candidate.updatedAt)
        }
      }
    }
  }
}
