/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import './bootstrap.ts'
import {
  buildAppHarness,
  piHarnessToUiMessageStream,
  writeAgentWorkspaceFiles,
  type AppHarness,
  type BuildAppHarnessOptions,
  type WorkspaceFile,
  type WorkspaceSnapshot,
} from '../../shared/agent-core/index.ts'
import { createPromptParts, type PromptParams } from '../../src/ai/prompt.ts'
import { readProfileThinkingLevel, resolveProfileReasoningEffort } from '../../src/ai/profile-thinking-level.ts'
import { buildClientIdentityBlock } from '../../shared/agent-core/client-identity.ts'
import { appHarnessEnvironmentPrompt } from '../../shared/agent-core/environment-prompt.ts'
import { catalogReasoningCapabilities } from '../../shared/agent-core/reasoning-capabilities.ts'
import { supportsPiCompaction } from '../../src/acp/built-in-model-support.ts'
import {
  preferredReasoningEffort,
  resolveReasoningEffort,
  type ReasoningEffort,
  type ReasoningCapabilities,
} from '../../shared/reasoning-effort.ts'
import { createNativeToolset, type NativeToolContext, type NativeToolset } from './native-tools.ts'
import { prepareBuiltInConversation, prepareBuiltInHistory, type BuiltInConversationDeps } from '../../src/acp/built-in-conversation-core.ts'
import { docxMime, isPlainTextMime, xlsxMime } from '../../src/files/transformers/mime.ts'
import { docxToText } from '../../src/files/transformers/docx-to-text.ts'
import { readXlsxSheets, xlsxToText } from '../../src/files/transformers/xlsx-to-text.ts'
import type { StoredFile } from '../../src/lib/file-blob-storage.ts'
import type { ThunderboltUIMessage } from '../../src/types.ts'
import type { ModelProfile } from '../../src/types.ts'
import { Buffer } from 'buffer'

type NativeRuntimeScope = typeof globalThis & {
  __thunderboltNative?: {
    loadWorkspace: (threadId: string) => string | null
    saveWorkspace: (threadId: string, snapshot: string) => boolean
    randomBytes: (size: number) => string
    randomUUID: () => string
    scheduleTimer: (id: string, delay: number, callback: () => void) => void
    cancelTimer: (id: string) => void
    startFetch: (
      id: string,
      request: string,
      onHeaders: (status: number, headersJSON: string) => void,
      onChunk: (base64: string) => void,
      onComplete: (error: string | null) => void,
    ) => void
    cancelFetch: (id: string) => void
    cancelNativeTool: (id: string) => void
    executeNativeTool: (id: string, threadId: string, name: string, argumentsJSON: string, callback: (resultJSON: string, error: string) => void) => void
  }
  __thunderboltPiRuntime?: {
    resolveReasoning: (provider: string, modelID: string, optionsJSON: string) => string
    supportsCompaction: (modelJSON: string) => boolean
    createHarness: (optionsJSON: string) => Promise<string>
    prepareConversation: (messagesJSON: string, attachmentsJSON: string, workspaceEnabled: boolean, skillInstructionsJSON: string) => Promise<string>
    compactConversation: (requestID: string, optionsJSON: string, messagesJSON: string, attachmentsJSON: string, workspaceEnabled: boolean, instructions: string | null) => Promise<string>
    cancelCompaction: (requestID: string) => void
    run: (harnessId: string, prompt: string, imagesJSON: string, onChunk: (chunk: string) => void, onDone: (error: string | null) => void) => void
    stop: (harnessId: string) => void
    dispose: (harnessId: string) => Promise<void>
    shutdown: () => Promise<void>
  }
}

type RuntimeOptions = Omit<BuildAppHarnessOptions, 'workspaceStore' | 'model'> & {
  model: Omit<BuildAppHarnessOptions['model'], 'fetch'>
  promptContext?: PromptParams
  requestHeaders?: Record<string, string>
  clientAppVersion?: string
  workspaceFiles?: WorkspaceFile[]
  toolContext?: NativeToolContext
  localToolContextID?: string
  reasoningEffort?: ReasoningEffort | null
  providerOptions?: ModelProfile['providerOptions'] | null
}

type NativeAttachmentInput = {
  localFileId: string
  filename: string
  mimeType: string
  base64: string
  extractedText?: string
}

const scope = globalThis as NativeRuntimeScope
const native = scope.__thunderboltNative
if (!native) throw new Error('The native JavaScript bridge must be installed before the Pi runtime bundle')

class RuntimeHeaders {
  private readonly items = new Map<string, string>()

  constructor(init?: HeadersInit | Record<string, string>) {
    if (init instanceof RuntimeHeaders) {
      init.items.forEach((value, key) => this.items.set(key, value))
    } else if (Array.isArray(init)) {
      init.forEach(([key, value]) => this.set(key, value))
    } else if (init) {
      Object.entries(init).forEach(([key, value]) => this.set(key, String(value)))
    }
  }

  append(name: string, value: string): void {
    const key = name.toLowerCase()
    const current = this.items.get(key)
    this.items.set(key, current ? `${current}, ${value}` : value)
  }

  delete(name: string): void { this.items.delete(name.toLowerCase()) }
  get(name: string): string | null { return this.items.get(name.toLowerCase()) ?? null }
  has(name: string): boolean { return this.items.has(name.toLowerCase()) }
  set(name: string, value: string): void { this.items.set(name.toLowerCase(), String(value).trim()) }
  forEach(callback: (value: string, key: string) => void): void { this.items.forEach(callback) }
  entries(): IterableIterator<[string, string]> { return this.items.entries() }
  keys(): IterableIterator<string> { return this.items.keys() }
  values(): IterableIterator<string> { return this.items.values() }
  [Symbol.iterator](): IterableIterator<[string, string]> { return this.entries() }
}

class RuntimeResponse {
  readonly body: ReadableStream<Uint8Array> | null
  readonly headers: RuntimeHeaders
  readonly status: number
  readonly statusText: string
  readonly url: string
  readonly redirected = false
  readonly type = 'basic'
  readonly ok: boolean

  constructor(body: ReadableStream<Uint8Array> | null, init: { status: number; headers: Record<string, string>; url: string }) {
    this.body = body
    this.status = init.status
    this.statusText = ''
    this.headers = new RuntimeHeaders(init.headers)
    this.url = init.url
    this.ok = this.status >= 200 && this.status < 300
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.bytes()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }

  async text(): Promise<string> { return new TextDecoder().decode(await this.bytes()) }
  async json(): Promise<unknown> { return JSON.parse(await this.text()) }

  private async bytes(): Promise<Uint8Array> {
    if (!this.body) return new Uint8Array()
    const reader = this.body.getReader()
    const chunks: Uint8Array[] = []
    let length = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      length += value.byteLength
    }
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
    return result
  }
}

const bodyAsBase64 = async (body: BodyInit | null | undefined): Promise<string | null> => {
  if (body == null) return null
  if (typeof body === 'string') return Buffer.from(body, 'utf8').toString('base64')
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8').toString('base64')
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer()).toString('base64')
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body)).toString('base64')
  if (ArrayBuffer.isView(body)) return Buffer.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)).toString('base64')
  throw new Error('The native fetch bridge does not support this request body type')
}

const createNativeFetch = (
  extraHeaders: Record<string, string> = {},
  baseURL?: string,
  modelKind?: BuildAppHarnessOptions['model']['kind'],
) => async (
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<RuntimeResponse> => {
  const requestInput = typeof input === 'string' || input instanceof URL ? undefined : input as Request
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const requestURL = new URL(url)
  const headers = new RuntimeHeaders(requestInput?.headers)
  new RuntimeHeaders(init.headers).forEach((value, key) => headers.set(key, value))
  if (baseURL && requestURL.origin === new URL(baseURL).origin) {
    const hasManagedAuthorization = Object.keys(extraHeaders).some((name) => name.toLowerCase() === 'authorization')
    if (modelKind === 'anthropic' && hasManagedAuthorization) headers.delete('x-api-key')
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value)
  }
  const body = init.body === undefined && requestInput?.body
    ? await requestInput.clone().arrayBuffer()
    : init.body
  const requestId = scope.crypto.randomUUID()
  const request = {
    url,
    method: init.method ?? requestInput?.method ?? 'GET',
    headers: Array.from(headers.entries()),
    body: await bodyAsBase64(body),
  }
  const signal = init.signal ?? requestInput?.signal
  return new Promise((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let headersReceived = false
    let bodyClosed = false
    const body = new ReadableStream<Uint8Array>({
      start(streamController) { controller = streamController },
      cancel() {
        bodyClosed = true
        native.cancelFetch(requestId)
      },
    })
    const abort = (): void => {
      native.cancelFetch(requestId)
      const failure = new Error('The request was aborted')
      if (!headersReceived) reject(failure)
      if (!bodyClosed) {
        bodyClosed = true
        controller?.error(failure)
      }
    }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      native.startFetch(
        requestId,
        JSON.stringify(request),
        (status, headersJSON) => {
          headersReceived = true
          resolve(new RuntimeResponse(body, { status, headers: JSON.parse(headersJSON) as Record<string, string>, url }))
        },
        (base64) => {
          if (!bodyClosed) controller?.enqueue(Uint8Array.from(Buffer.from(base64, 'base64')))
        },
        (error) => {
          signal?.removeEventListener('abort', abort)
          if (error) {
            const failure = new Error(error)
            if (!bodyClosed) {
              bodyClosed = true
              controller?.error(failure)
            }
            if (!headersReceived) reject(failure)
          } else if (!bodyClosed) {
            bodyClosed = true
            controller?.close()
          }
        },
      )
    } catch (error) {
      signal?.removeEventListener('abort', abort)
      reject(error)
    }
  })
}

// JavaScriptCore may expose a fetch stub that is not backed by URLSession.
// Provider traffic must use the native transport so it can stream and enforce origin policy.
scope.fetch = createNativeFetch() as typeof fetch
scope.Headers ??= RuntimeHeaders as unknown as typeof Headers
scope.Response ??= RuntimeResponse as unknown as typeof Response

const harnesses = new Map<string, AppHarness>()
const activeRuns = new Map<string, AbortController>()
const activeCompactions = new Map<string, AbortController>()
const activeThreads = new Map<string, string>()
const harnessThreads = new Map<string, string>()
const retiringHarnesses = new Map<string, Promise<void>>()
const pendingCreations = new Set<Promise<void>>()
const harnessToolsets = new Map<string, NativeToolset>()
let isShuttingDown = false
let shutdownPromise: Promise<void> | undefined

const disposeHarness = async (harnessID: string): Promise<void> => {
  const currentRetirement = retiringHarnesses.get(harnessID)
  if (currentRetirement) return currentRetirement
  const harness = harnesses.get(harnessID)
  if (!harness) return

  const retirement = (async () => {
    try {
      try {
        if (activeRuns.has(harnessID)) {
          activeRuns.get(harnessID)?.abort()
          await harness.abort()
        }
      } finally {
        await harness.waitForIdle()
      }
    } finally {
      if (harnesses.get(harnessID) === harness) harnesses.delete(harnessID)
      harnessToolsets.delete(harnessID)
      activeRuns.delete(harnessID)
      const threadID = harnessThreads.get(harnessID)
      if (threadID && activeThreads.get(threadID) === harnessID) activeThreads.delete(threadID)
      harnessThreads.delete(harnessID)
    }
  })()
  retiringHarnesses.set(harnessID, retirement)
  try {
    await retirement
  } finally {
    retiringHarnesses.delete(harnessID)
  }
}

const nativeWorkspaceStore = () => {
  const native = (globalThis as NativeRuntimeScope).__thunderboltNative
  if (!native) throw new Error('Native workspace storage is unavailable')
  return {
    load: async (threadId: string): Promise<WorkspaceSnapshot | undefined> => {
      const value = native.loadWorkspace(threadId)
      // Objective-C bridging can surface an optional Swift string as `undefined`
      // rather than `null` in JavaScriptCore.
      return value === null || value === undefined ? undefined : JSON.parse(value) as WorkspaceSnapshot
    },
    save: async (threadId: string, snapshot: WorkspaceSnapshot): Promise<void> => {
      if (!native.saveWorkspace(threadId, JSON.stringify(snapshot))) {
        throw new Error('The workspace could not be saved to this device')
      }
    },
  }
}

const executeNativeTool = (
  threadID: string,
  name: string,
  argumentsJSON: string,
  signal?: AbortSignal,
): Promise<unknown> => new Promise((resolve, reject) => {
  const requestID = scope.crypto.randomUUID()
  let settled = false
  const finish = (resultJSON: string, error: string): void => {
    if (settled) return
    settled = true
    signal?.removeEventListener('abort', abort)
    if (error) {
      reject(new Error(error))
      return
    }
    try {
      resolve(JSON.parse(resultJSON) as unknown)
    } catch (parseError) {
      reject(parseError)
    }
  }
  const abort = (): void => {
    native?.cancelNativeTool(requestID)
    finish('', 'Native tool call was aborted')
  }
  if (signal?.aborted) {
    abort()
    return
  }
  signal?.addEventListener('abort', abort, { once: true })
  native?.executeNativeTool(requestID, threadID, name, argumentsJSON, (resultJSON, error) => {
    finish(resultJSON, error)
  })
})

const conversationDependencies = (attachmentsJSON: string): {
  attachmentInputs: NativeAttachmentInput[]
  deps: BuiltInConversationDeps
} => {
  const attachmentInputs = JSON.parse(attachmentsJSON) as NativeAttachmentInput[]
  const attachmentData = new Map(attachmentInputs.map((attachment) => [attachment.localFileId, attachment]))
  const attachments = new Map<string, StoredFile>(attachmentInputs.map((attachment) => {
    const bytes = Buffer.from(attachment.base64, 'base64')
    const file: StoredFile = {
      id: attachment.localFileId,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: bytes.byteLength,
      createdAt: 0,
      blob: new Blob([bytes], { type: attachment.mimeType }),
    }
    return [attachment.localFileId, file]
  }))
  return {
    attachmentInputs,
    deps: {
      getAttachment: async (id) => attachments.get(id) ?? null,
      getTransformer: async (mimeType, target) => {
        if (mimeType === 'application/pdf' && target === 'text') {
          if (!attachmentInputs.some((attachment) => attachment.mimeType === mimeType && attachment.extractedText !== undefined)) return null
          return async (file) => ({ text: attachmentData.get(file.id)?.extractedText ?? '' })
        }
        if (target === 'images' && mimeType.startsWith('image/')) {
          return async (file) => ({
            images: [{ mimeType, dataUrl: `data:${mimeType};base64,${Buffer.from(await file.blob.arrayBuffer()).toString('base64')}` }],
          })
        }
        if (target !== 'text') return null
        if (mimeType === docxMime) return docxToText
        if (mimeType === xlsxMime) return xlsxToText
        if (isPlainTextMime(mimeType)) {
          return async (file) => ({ text: Buffer.from(await file.blob.arrayBuffer()).toString('utf8') })
        }
        return null
      },
      blobToBase64: async (blob) => Buffer.from(await blob.arrayBuffer()).toString('base64'),
      readXlsxSheets,
    },
  }
}

const runtime = (globalThis as NativeRuntimeScope).__thunderboltPiRuntime = {
  supportsCompaction(modelJSON: string): boolean {
    return supportsPiCompaction(JSON.parse(modelJSON) as Pick<Model, 'provider' | 'toolUsage' | 'model' | 'vendor' | 'apiKey' | 'url'>)
  },

  resolveReasoning(provider: string, modelID: string, optionsJSON: string): string {
    const options = JSON.parse(optionsJSON) as {
      savedEffort?: unknown
      profileOptionsJSON?: string | null
      capabilitiesJSON?: string | null
    }
    const capabilities = options.capabilitiesJSON
      ? JSON.parse(options.capabilitiesJSON) as ReasoningCapabilities
      : catalogReasoningCapabilities(provider, modelID)
    const profileOptions = options.profileOptionsJSON
      ? JSON.parse(options.profileOptionsJSON) as ModelProfile['providerOptions']
      : undefined
    const profileEffort = resolveProfileReasoningEffort(profileOptions, capabilities)
    const preference = resolveReasoningEffort(options.savedEffort, capabilities)
    const preferred = preferredReasoningEffort(options.savedEffort, capabilities, profileEffort)
    const profileLevel = readProfileThinkingLevel(profileOptions) ?? 'medium'
    const requestEffort = preference !== undefined || profileEffort !== undefined ? preference : preferred
    const activeEffort = requestEffort ?? profileLevel
    const thinkingLevel = activeEffort === 'none' ? 'off' : activeEffort
    return JSON.stringify({
      capabilities,
      preference: preference ?? null,
      requestEffort: requestEffort ?? null,
      profileEffort: profileEffort ?? null,
      profileConfigured: profileEffort !== undefined,
      preferredEffort: preferred ?? null,
      thinkingLevel,
    })
  },

  async prepareConversation(
    messagesJSON: string,
    attachmentsJSON: string,
    workspaceEnabled: boolean,
    skillInstructionsJSON: string,
  ): Promise<string> {
    const { deps } = conversationDependencies(attachmentsJSON)
    const prepared = await prepareBuiltInConversation(
      JSON.parse(messagesJSON) as ThunderboltUIMessage[],
      JSON.parse(skillInstructionsJSON) as string[] | undefined,
      { workspace: workspaceEnabled },
      deps,
    )
    return JSON.stringify(prepared)
  },

  async compactConversation(
    requestID: string,
    optionsJSON: string,
    messagesJSON: string,
    attachmentsJSON: string,
    workspaceEnabled: boolean,
    instructions: string | null,
  ): Promise<string> {
    const options = JSON.parse(optionsJSON) as RuntimeOptions
    if (activeCompactions.has(requestID)) throw new Error('This Pi compaction request is already active')
    const controller = new AbortController()
    activeCompactions.set(requestID, controller)
    let harnessID: string | undefined
    try {
      const { deps } = conversationDependencies(attachmentsJSON)
      const prepared = await prepareBuiltInHistory(
        JSON.parse(messagesJSON) as ThunderboltUIMessage[],
        { workspace: workspaceEnabled },
        deps,
      )
      controller.signal.throwIfAborted()
      harnessID = await runtime.createHarness(JSON.stringify({
        ...options,
        history: prepared.history,
        compaction: prepared.compaction ?? null,
        workspaceFiles: prepared.files,
      }))
      controller.signal.throwIfAborted()
      const harness = harnesses.get(harnessID)
      if (!harness) throw new Error('The Pi compaction harness is unavailable')
      const profileLevel = readProfileThinkingLevel(options.providerOptions ?? undefined) ?? 'medium'
      await harness.setReasoningEffort(options.reasoningEffort ?? undefined, profileLevel)
      const checkpoint = await harness.compaction.compact({ instructions: instructions?.trim() || undefined, signal: controller.signal })
      return JSON.stringify(checkpoint)
    } finally {
      try {
        if (harnessID) await runtime.dispose(harnessID)
      } finally {
        activeCompactions.delete(requestID)
      }
    }
  },

  cancelCompaction(requestID: string): void {
    activeCompactions.get(requestID)?.abort()
  },

  async createHarness(optionsJSON: string): Promise<string> {
    if (isShuttingDown) throw new Error('The Pi runtime is shutting down')
    let finishCreation!: () => void
    const creation = new Promise<void>((resolve) => { finishCreation = resolve })
    pendingCreations.add(creation)
    try {
      const options = JSON.parse(optionsJSON) as RuntimeOptions
      const existingID = activeThreads.get(options.threadId)
      if (existingID) {
        const retirement = retiringHarnesses.get(existingID)
        if (!retirement) throw new Error(`A Pi runtime is already active for thread ${options.threadId}`)
        await retirement
        if (isShuttingDown) throw new Error('The Pi runtime is shutting down')
        if (activeThreads.has(options.threadId)) throw new Error(`A Pi runtime is already active for thread ${options.threadId}`)
      }
      const harnessID = scope.crypto.randomUUID()
      activeThreads.set(options.threadId, harnessID)
      const fetch = createNativeFetch(options.requestHeaders, options.model.baseURL, options.model.kind)
      const {
        promptContext, requestHeaders: _requestHeaders, clientAppVersion, workspaceFiles,
        toolContext, localToolContextID, reasoningEffort, providerOptions, ...harnessOptions
      } = options
      const nativeToolset = toolContext && harnessOptions.codingToolsEnabled !== false
        ? await createNativeToolset(toolContext, localToolContextID ?? options.threadId, executeNativeTool)
        : undefined
      const promptParts = promptContext ? createPromptParts(promptContext) : undefined
      const skillListing = nativeToolset?.skillListing ? `\n\n${nativeToolset.skillListing}` : ''
      const stableSystemPrompt = `${promptParts?.stablePrompt ?? harnessOptions.systemPrompt}${skillListing}`
      const volatileSystemPrompt = promptParts?.volatilePrompt ?? ''
      const clientIdentity = buildClientIdentityBlock({ environment: 'ios', appVersion: clientAppVersion })
      const environmentBlock = harnessOptions.codingToolsEnabled === false ? '' : `\n\n${appHarnessEnvironmentPrompt}`
      try {
        const harness = await buildAppHarness({
          ...harnessOptions,
          systemPrompt: `${stableSystemPrompt}\n\n${clientIdentity}${environmentBlock}\n\n${volatileSystemPrompt}`,
          tools: [...(harnessOptions.tools ?? []), ...(nativeToolset?.tools ?? [])],
          model: { ...harnessOptions.model, fetch },
          workspaceStore: nativeWorkspaceStore(),
        } as BuildAppHarnessOptions)
        const profileLevel = readProfileThinkingLevel(providerOptions ?? undefined) ?? 'medium'
        await harness.setReasoningEffort(reasoningEffort ?? undefined, profileLevel)
        if (workspaceFiles?.length) {
          const failures = await writeAgentWorkspaceFiles(options.threadId, workspaceFiles)
          if (failures.length > 0) {
            throw new Error(`Could not prepare workspace attachment: ${failures.map(({ path }) => path).join(', ')}`)
          }
          await harness.persistWorkspace()
        }
        harnesses.set(harnessID, harness)
        harnessThreads.set(harnessID, options.threadId)
        if (nativeToolset) harnessToolsets.set(harnessID, nativeToolset)
        return harnessID
      } catch (error) {
        if (activeThreads.get(options.threadId) === harnessID) activeThreads.delete(options.threadId)
        throw error
      }
    } finally {
      pendingCreations.delete(creation)
      finishCreation()
    }
  },

  run(harnessId, prompt, imagesJSON, onChunk, onDone): void {
    const harness = harnesses.get(harnessId)
    if (!harness) throw new Error(`No Pi runtime is active for thread ${harnessId}`)
    if (activeRuns.has(harnessId)) throw new Error(`Pi runtime is already working on thread ${harnessId}`)
    const controller = new AbortController()
    activeRuns.set(harnessId, controller)
    const toolset = harnessToolsets.get(harnessId)
    const initialCompactionRevision = harness.compaction.revision
    let checkpoint: Awaited<ReturnType<AppHarness['compaction']['checkpoint']>> | undefined
    const removeCheckpointListener = harness.subscribe(async (event) => {
      if (
        (event.type === 'turn_end' || event.type === 'agent_end') &&
        harness.compaction.revision !== initialCompactionRevision
      ) {
        checkpoint = await harness.compaction.checkpoint()
      }
    })
    const stream = piHarnessToUiMessageStream(
      harness,
      () => harness.prompt(prompt, { images: JSON.parse(imagesJSON || '[]') }),
      {
        toolCall: (toolName) => {
          const owner = toolset?.mcpTools[toolName]
          return {
            modelId: harness.model.id,
            ...(owner ? { mcpTools: { [toolName]: owner } } : {}),
          }
        },
        settled: () => ({
          modelId: harness.model.id,
          ...(toolset?.sourceCollector.length ? { sources: [...toolset.sourceCollector] } : {}),
          ...(toolset && Object.keys(toolset.mcpTools).length > 0 ? { mcpTools: toolset.mcpTools } : {}),
          ...(checkpoint ? { contextCompaction: checkpoint, contextTokens: checkpoint.contextTokens } : {}),
        }),
      },
      controller.signal,
    )
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    void (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          onChunk(decoder.decode(value, { stream: true }))
        }
        const tail = decoder.decode()
        if (tail) onChunk(tail)
        onDone(null)
      } catch (error) {
        onDone(error instanceof Error ? error.message : String(error))
      } finally {
        activeRuns.delete(harnessId)
        removeCheckpointListener()
      }
    })()
  },

  stop(harnessId): void {
    activeRuns.get(harnessId)?.abort()
  },

  dispose(harnessId): Promise<void> { return disposeHarness(harnessId) },

  shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    isShuttingDown = true
    shutdownPromise = (async () => {
      const failures: unknown[] = []
      while (pendingCreations.size > 0) {
        const results = await Promise.allSettled([...pendingCreations])
        failures.push(...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []))
      }
      const results = await Promise.allSettled(Array.from(harnesses.keys(), (harnessID) => disposeHarness(harnessID)))
      failures.push(...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []))
      if (failures.length > 0) throw failures[0]
    })()
    return shutdownPromise
  },
}
