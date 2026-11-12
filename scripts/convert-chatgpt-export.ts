/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { v7 as uuidv7 } from 'uuid'

const maxImportBytes = 200 * 1024 * 1024
const conversationFilePattern = /^conversations(?:-\d+)?\.json$/
const supportedContentTypes = new Set(['text', 'code', 'multimodal_text'])

type JsonRecord = Record<string, unknown>

type ChatMessageNode = {
  parent: string | null
  children: string[]
  message: JsonRecord | null
}

type ConvertedThread = {
  id: string
  title: string
  isEncrypted: 0
  triggeredBy: null
  wasTriggeredByAutomation: 0
  contextSize: null
  acpSessionId: null
  agentId: null
  projectId: null
  miniAppId: null
  deletedAt: null
  userId: string
}

type ConvertedMessage = {
  id: string
  content: string
  role: 'user' | 'assistant'
  parts: { type: 'text'; text: string }[]
  chatThreadId: string
  modelId: null
  parentId: string | null
  cache: null
  metadata: Record<string, unknown>
  deletedAt: null
  userId: string
}

export type ChatGptConversionResult = {
  export: {
    format: 'thunderbolt-export'
    schemaVersion: 1
    exportedAt: string
    user: { id: string; email: null }
    tables: {
      chat_threads: ConvertedThread[]
      chat_messages: ConvertedMessage[]
    }
  }
  stats: {
    inputConversations: number
    importedConversations: number
    importedMessages: number
    omittedMessages: number
    unselectedNodes: number
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const timestampFrom = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value
    return Math.trunc(milliseconds)
  }
  if (typeof value !== 'string') {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

const toMessageNodes = (mapping: JsonRecord): Map<string, ChatMessageNode> =>
  new Map(
    Object.entries(mapping).flatMap(([key, value]) => {
      if (!isRecord(value)) {
        return []
      }
      const message = isRecord(value.message) ? value.message : null
      return [
        [
          key,
          {
            parent: typeof value.parent === 'string' ? value.parent : null,
            children: Array.isArray(value.children)
              ? value.children.filter((child): child is string => typeof child === 'string')
              : [],
            message,
          },
        ],
      ]
    }),
  )

const getNodeTimestamp = (node: ChatMessageNode): number =>
  timestampFrom(node.message?.create_time) ?? Number.NEGATIVE_INFINITY

const getActivePath = (nodes: Map<string, ChatMessageNode>, currentNode: unknown): ChatMessageNode[] => {
  const selectedNode =
    typeof currentNode === 'string' && nodes.has(currentNode)
      ? currentNode
      : ([...nodes.entries()]
          .filter(([, node]) => !node.children.some((child) => nodes.has(child)))
          .sort((left, right) => getNodeTimestamp(right[1]) - getNodeTimestamp(left[1]))[0]?.[0] ??
        [...nodes.keys()].at(-1))

  if (!selectedNode) {
    return []
  }

  const path: ChatMessageNode[] = []
  const visited = new Set<string>()
  let nodeId: string | null = selectedNode
  while (nodeId !== null && !visited.has(nodeId)) {
    visited.add(nodeId)
    const node = nodes.get(nodeId)
    if (!node) {
      break
    }
    path.push(node)
    nodeId = node.parent
  }

  return path.reverse()
}

const textFromContent = (content: unknown): string => {
  if (!isRecord(content)) {
    return ''
  }
  if (typeof content.content_type === 'string' && !supportedContentTypes.has(content.content_type)) {
    return ''
  }

  const parts = Array.isArray(content.parts) ? content.parts : typeof content.text === 'string' ? [content.text] : []
  return parts
    .map((part) => {
      if (typeof part === 'string') {
        return part
      }
      if (!isRecord(part)) {
        return ''
      }
      if (typeof part.text === 'string') {
        return part.text
      }
      return typeof part.transcript === 'string' ? part.transcript : ''
    })
    .join('')
}

/**
 * Converts ChatGPT conversation objects into the chat tables of a Thunderbolt
 * backup. Only the active message path and readable user/assistant text are
 * imported; other roles, hidden reasoning, and non-text payloads are omitted.
 */
export const convertChatGptConversations = (
  conversations: unknown[],
  exportedAt = new Date(),
): ChatGptConversionResult => {
  const chatThreads: ConvertedThread[] = []
  const chatMessages: ConvertedMessage[] = []
  let omittedMessages = 0
  let unselectedNodes = 0

  for (const [index, conversationValue] of conversations.entries()) {
    if (!isRecord(conversationValue) || !isRecord(conversationValue.mapping)) {
      throw new Error(`Conversation ${index + 1} is missing its message mapping.`)
    }

    const nodes = toMessageNodes(conversationValue.mapping)
    const path = getActivePath(nodes, conversationValue.current_node)
    unselectedNodes += Math.max(0, nodes.size - path.length)

    const conversationTimestamp = timestampFrom(conversationValue.create_time) ?? exportedAt.getTime()
    const threadId = uuidv7({ msecs: conversationTimestamp })
    const title = typeof conversationValue.title === 'string' ? conversationValue.title : 'ChatGPT chat'
    const convertedMessages: ConvertedMessage[] = []
    let parentId: string | null = null
    let lastMessageTimestamp = conversationTimestamp - 1

    for (const node of path) {
      const message = node.message
      if (!message) {
        continue
      }
      const role = isRecord(message.author) ? message.author.role : null
      const content = textFromContent(message.content)
      if ((role !== 'user' && role !== 'assistant') || content.trim().length === 0) {
        omittedMessages += 1
        continue
      }

      const sourceTimestamp = timestampFrom(message.create_time) ?? conversationTimestamp
      lastMessageTimestamp = Math.max(sourceTimestamp, lastMessageTimestamp + 1)
      const id = uuidv7({ msecs: lastMessageTimestamp })
      convertedMessages.push({
        id,
        content,
        role,
        parts: [{ type: 'text', text: content }],
        chatThreadId: threadId,
        modelId: null,
        parentId,
        cache: null,
        metadata: {},
        deletedAt: null,
        userId: 'chatgpt-import',
      })
      parentId = id
    }

    if (convertedMessages.length === 0) {
      continue
    }

    chatThreads.push({
      id: threadId,
      title,
      isEncrypted: 0,
      triggeredBy: null,
      wasTriggeredByAutomation: 0,
      contextSize: null,
      acpSessionId: null,
      agentId: null,
      projectId: null,
      miniAppId: null,
      deletedAt: null,
      userId: 'chatgpt-import',
    })
    chatMessages.push(...convertedMessages)
  }

  return {
    export: {
      format: 'thunderbolt-export',
      schemaVersion: 1,
      exportedAt: exportedAt.toISOString(),
      user: { id: 'chatgpt-import', email: null },
      tables: { chat_threads: chatThreads, chat_messages: chatMessages },
    },
    stats: {
      inputConversations: conversations.length,
      importedConversations: chatThreads.length,
      importedMessages: chatMessages.length,
      omittedMessages,
      unselectedNodes,
    },
  }
}

const readConversations = async (filePath: string): Promise<unknown[]> => {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'))
  if (Array.isArray(parsed)) {
    return parsed
  }
  if (isRecord(parsed) && Array.isArray(parsed.conversations)) {
    return parsed.conversations
  }
  throw new Error(`"${filePath}" does not contain a ChatGPT conversations array.`)
}

const inputFilesFor = async (inputPath: string): Promise<string[]> => {
  const inputStat = await stat(inputPath)
  if (inputStat.isFile()) {
    return [inputPath]
  }

  const files = (await readdir(inputPath))
    .filter((name) => conversationFilePattern.test(name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((name) => join(inputPath, name))
  if (files.length === 0) {
    throw new Error(`No conversations.json or conversations-NNN.json files found in "${inputPath}".`)
  }
  return files
}

const main = async (): Promise<void> => {
  const [inputArgument, outputArgument] = process.argv.slice(2)
  if (!inputArgument || inputArgument === '--help' || inputArgument === '-h') {
    console.log('Usage: bun run convert:chatgpt -- <export-directory-or-json-file> [output.json]')
    return
  }

  const inputPath = resolve(inputArgument)
  const files = await inputFilesFor(inputPath)
  const conversations: unknown[] = []
  for (const file of files) {
    conversations.push(...(await readConversations(file)))
  }

  const result = convertChatGptConversations(conversations)
  const json = `${JSON.stringify(result.export, null, 2)}\n`
  const outputBytes = Buffer.byteLength(json)
  if (outputBytes > maxImportBytes) {
    throw new Error(
      `Converted file is ${(outputBytes / 1024 / 1024).toFixed(0)} MB; Thunderbolt imports are limited to 200 MB.`,
    )
  }

  const outputPath = resolve(
    outputArgument ??
      join(
        files.length > 1 || (await stat(inputPath)).isDirectory() ? inputPath : dirname(inputPath),
        'thunderbolt-chatgpt-import.json',
      ),
  )
  await writeFile(outputPath, json, { flag: 'wx' })

  console.log(`Created ${outputPath}`)
  console.log(`Read ${files.length} conversation file${files.length === 1 ? '' : 's'}.`)
  console.log(
    `Imported ${result.stats.importedMessages} messages across ${result.stats.importedConversations} conversations.`,
  )
  console.log(
    `Omitted ${result.stats.omittedMessages} unsupported or empty messages and ${result.stats.unselectedNodes} unselected message nodes.`,
  )
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
