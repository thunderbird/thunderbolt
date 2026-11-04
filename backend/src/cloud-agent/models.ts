/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  createProvider,
  type AssistantMessage,
  type Model,
  type Provider,
  type ProviderStreams,
} from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { TranscriptContext } from '@earendil-works/pi-ai/utils/transcript'
import type { CloudModel } from '@shared/cloud-agent/contracts'

export type CloudModelCredentials = {
  apiKey: string
  baseUrl?: string
  api?: 'anthropic-messages' | 'openai-completions' | 'openai-responses'
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  fetch?: typeof fetch
  headers?: Record<string, string>
}

export type CloudModelCallbacks = {
  beforeRequest: (context: TranscriptContext, signal?: AbortSignal) => Promise<number>
  afterResponse: (request: number, message: AssistantMessage) => Promise<void>
  onError: (error: unknown) => void
}

/** Create a per-run provider with explicit credentials, transport and durable request accounting. */
export const createCloudModelProvider = (
  runId: string,
  configured: CloudModel,
  credentials: CloudModelCredentials,
  callbacks: CloudModelCallbacks,
): { provider: Provider; model: Model<'anthropic-messages' | 'openai-completions' | 'openai-responses'> } => {
  const providerId = `cloud-${runId}`
  const api = credentials.api ?? (configured.provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions')
  const baseUrl =
    credentials.baseUrl ??
    configured.baseUrl ??
    (api === 'anthropic-messages' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')
  if (
    Object.values(credentials.cost).some((value) => !Number.isFinite(value) || value < 0) ||
    (credentials.cost.input === 0 && credentials.cost.output === 0)
  ) {
    throw new Error('model_pricing_required')
  }
  const model: Model<typeof api> = {
    id: configured.modelId,
    name: configured.modelId,
    api,
    provider: providerId,
    baseUrl,
    input: ['text'],
    cost: credentials.cost,
    reasoning: false,
    contextWindow: configured.contextWindow,
    maxTokens: configured.maxOutputTokens,
    ...(credentials.headers ? { headers: credentials.headers } : {}),
  }
  const implementation =
    api === 'anthropic-messages'
      ? anthropicMessagesApi()
      : api === 'openai-responses'
        ? openAIResponsesApi()
        : openAICompletionsApi()
  const wrap =
    (method: 'stream' | 'streamSimple'): ProviderStreams['streamSimple'] =>
    (requested, transcript, options) => {
      const output = createAssistantMessageEventStream()
      void (async () => {
        try {
          const request = await callbacks.beforeRequest(transcript, options?.signal)
          const source = implementation[method](requested, transcript, {
            ...options,
            maxTokens: configured.maxOutputTokens,
            maxRetries: 0,
            ...(credentials.fetch ? { fetch: credentials.fetch } : {}),
          })
          // Publish completion only after its usage has been durably accounted for.
          for await (const event of source) {
            if (event.type !== 'done' && event.type !== 'error') {
              output.push(event)
            }
          }
          const response = await source.result()
          await callbacks.afterResponse(request, response)
          if (response.stopReason === 'pending') {
            throw new Error('model_response_pending')
          }
          if (response.stopReason === 'error' || response.stopReason === 'aborted') {
            output.push({ type: 'error', reason: response.stopReason, error: response })
          } else {
            output.push({ type: 'done', reason: response.stopReason, message: response })
          }
          output.end(response)
        } catch (error) {
          callbacks.onError(error)
          const message: AssistantMessage = {
            role: 'assistant',
            content: [],
            api,
            provider: providerId,
            model: configured.modelId,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: options?.signal?.aborted ? 'aborted' : 'error',
            errorMessage: 'Cloud model request could not continue',
            timestamp: Date.now(),
          }
          output.push({ type: 'error', reason: message.stopReason as 'error' | 'aborted', error: message })
          output.end(message)
        }
      })()
      return output
    }
  const provider = createProvider({
    id: providerId,
    baseUrl,
    models: [model],
    auth: {
      apiKey: {
        name: 'Granted cloud model credential',
        resolve: async () => ({ auth: { apiKey: credentials.apiKey, baseUrl, headers: credentials.headers } }),
      },
    },
    api: { stream: wrap('stream'), streamSimple: wrap('streamSimple') },
  })
  return { provider, model }
}
