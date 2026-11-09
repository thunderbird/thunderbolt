/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolveOpenAiCompatConnection, type OpenAiCompatConnection } from '@/ai/fetch'
import { streamProbe } from '@/ai/stream-probe'
import { createOpenAI } from '@ai-sdk/openai'
import { APICallError } from 'ai'
import type { FetchFn } from '@/lib/proxy-fetch'
import { bindModelProvider } from '@/providers/model-connection'
import type { Model } from '@/types'
import type { ImageSupport } from '@shared/defaults/models'
import { z } from 'zod'

/** 64×64 solid green PNG, large enough to clear providers' minimum image sizes. */
const probeImageDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATElEQVR42u3PQQkAAAgAseufzFhG8C0MVmA1/SYgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcFncr4C1OHup8AAAAABJRU5ErkJggg=='

const probeQuestion = 'What color is this image? Answer in English with one word.'

/** The probe couldn't reach a verdict (auth, network, timeout, server error). Never cached. */
export class ImageSupportInconclusiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageSupportInconclusiveError'
  }
}

/** Statuses a provider returns when it can't accept a request's content. */
const contentRejectionStatuses: ReadonlySet<number> = new Set([400, 415, 422])

const completionSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
})

/**
 * The text a chat completion answered with, or '' when it has none. Reasoning is
 * ignored on purpose: a text-only model can guess "green" while thinking out loud,
 * which would wrongly mark it as reading images.
 */
const completionText = (body: unknown): string => {
  const parsed = completionSchema.safeParse(body)
  return parsed.success ? (parsed.data.choices[0].message.content?.trim() ?? '') : ''
}

type ProbeContent = string | Array<{ type: 'text'; text: string } | { type: 'image'; image: URL }>

/** Keep the compatible probe lightweight while sharing error handling with Responses. */
const postChatCompletion = async (
  connection: OpenAiCompatConnection,
  modelId: string,
  content: ProbeContent,
  signal: AbortSignal,
) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (connection.apiKey) {
    headers.Authorization = `Bearer ${connection.apiKey}`
  }
  const url = `${connection.baseURL.replace(/\/+$/, '')}/chat/completions`
  const response = await connection.fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: modelId,
      messages: [
        {
          role: 'user',
          content:
            typeof content === 'string'
              ? content
              : content.map((part) =>
                  part.type === 'image' ? { type: 'image_url', image_url: { url: part.image.href } } : part,
                ),
        },
      ],
      stream: false,
    }),
    signal,
  })
  if (!response.ok) {
    throw new APICallError({ message: 'Image probe failed', url, requestBodyValues: {}, statusCode: response.status })
  }
  return completionText(await response.json())
}

/**
 * Ask a model what color a solid green image is, over the same OpenAI-compatible
 * connection real chats use. Naming the color proves the image reached the
 * model, which also catches servers that accept an image and silently drop it.
 * When the provider rejects the request, a text-only follow-up confirms the
 * image was the problem rather than the key, the model id, or the endpoint.
 *
 * @param inputModel - the model to test, with its connection settings and api key
 * @param getProxyFetch - lazily resolved universal proxy fetch
 * @param signal - the caller's deadline, shared by the probe and its follow-up
 * @returns whether the model read the image
 * @throws {ImageSupportInconclusiveError} when the provider answers but no verdict is possible
 *   (no connection, an auth/rate-limit/server status, an empty answer, a failed follow-up)
 * @throws the underlying error on a network failure, the deadline, or a reply that isn't JSON.
 *   Either way the caller must not cache anything.
 */
export const probeImageSupport = async (
  inputModel: Model,
  getProxyFetch: () => FetchFn,
  signal: AbortSignal,
): Promise<ImageSupport> => {
  const { model, wrapFetch, api } = await bindModelProvider(inputModel)
  const resolved = resolveOpenAiCompatConnection(model, getProxyFetch)
  if (!resolved) {
    throw new ImageSupportInconclusiveError(`No OpenAI-compatible connection for provider "${model.provider}"`)
  }
  const connection = { ...resolved, fetch: wrapFetch(resolved.fetch) }
  const send =
    api === 'openai-responses'
      ? (content: ProbeContent) =>
          streamProbe({
            model: createOpenAI(connection).responses(model.model),
            messages: [{ role: 'user', content }],
            maxRetries: 0,
            abortSignal: signal,
          })
      : (content: ProbeContent) => postChatCompletion(connection, model.model, content, signal)
  try {
    const answer = await send([
      { type: 'text', text: probeQuestion },
      { type: 'image', image: new URL(probeImageDataUrl) },
    ])
    if (!answer.trim()) {
      throw new ImageSupportInconclusiveError('Probe completion carried no answer')
    }
    // Deliberately literal: "lime", "verde", or a hex code counts as unsupported
    // and is cached. The composer's "Try anyway" is the escape hatch for that.
    return /\bgreen\b/i.test(answer) ? 'supported' : 'unsupported'
  } catch (error) {
    if (!APICallError.isInstance(error)) {
      throw error
    }
    if (!contentRejectionStatuses.has(error.statusCode ?? 0)) {
      throw new ImageSupportInconclusiveError(`Probe failed with status ${error.statusCode}`)
    }
    try {
      await send('Reply with the word ok.')
    } catch (controlError) {
      if (APICallError.isInstance(controlError)) {
        throw new ImageSupportInconclusiveError(`Probe control request failed with status ${controlError.statusCode}`)
      }
      throw controlError
    }
    return 'unsupported'
  }
}
