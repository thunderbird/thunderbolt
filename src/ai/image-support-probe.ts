/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { resolveOpenAiCompatConnection, type OpenAiCompatConnection } from '@/ai/fetch'
import type { FetchFn } from '@/lib/proxy-fetch'
import type { Model } from '@/types'
import type { ImageSupport } from '@shared/defaults/models'
import { z } from 'zod'

/** 64×64 solid green PNG, large enough to clear providers' minimum image sizes. */
const probeImageDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATElEQVR42u3PQQkAAAgAseufzFhG8C0MVmA1/SYgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcFncr4C1OHup8AAAAABJRU5ErkJggg=='

const probeQuestion = 'What color is this image? Answer in English with one word.'

/** Upper bound on the whole probe, follow-up included, generous enough for a cold local model to load.
 *  The composer holds the send for this long at most. */
export const probeTimeoutMs = 30_000

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
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish(), reasoning_content: z.string().nullish() }),
      }),
    )
    .min(1),
})

/** The text a chat completion answered with, falling back to its reasoning, or '' when it has neither. */
const completionText = (body: unknown): string => {
  const parsed = completionSchema.safeParse(body)
  if (!parsed.success) {
    return ''
  }
  const { content, reasoning_content: reasoning } = parsed.data.choices[0].message
  return content?.trim() || reasoning?.trim() || ''
}

type ProbeContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>

const postChatCompletion = (
  connection: OpenAiCompatConnection,
  modelId: string,
  content: ProbeContent,
  signal: AbortSignal,
) =>
  connection.fetch(`${connection.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content }], stream: false }),
    signal,
  })

/**
 * Ask a model what color a solid green image is, over the same OpenAI-compatible
 * connection real chats use. Naming the color proves the image reached the
 * model, which also catches servers that accept an image and silently drop it.
 * When the provider rejects the request, a text-only follow-up confirms the
 * image was the problem rather than the key, the model id, or the endpoint.
 *
 * @param model - the model to test, with its connection settings and api key
 * @param getProxyFetch - lazily resolved universal proxy fetch
 * @returns whether the model read the image
 * @throws {ImageSupportInconclusiveError} when no verdict is possible (the caller must not cache it)
 */
export const probeImageSupport = async (model: Model, getProxyFetch: () => FetchFn): Promise<ImageSupport> => {
  const connection = resolveOpenAiCompatConnection(model, getProxyFetch)
  if (!connection) {
    throw new ImageSupportInconclusiveError(`No OpenAI-compatible connection for provider "${model.provider}"`)
  }

  const signal = AbortSignal.timeout(probeTimeoutMs)
  const response = await postChatCompletion(
    connection,
    model.model,
    [
      { type: 'text', text: probeQuestion },
      { type: 'image_url', image_url: { url: probeImageDataUrl } },
    ],
    signal,
  )
  if (response.ok) {
    const answer = completionText(await response.json())
    if (!answer) {
      throw new ImageSupportInconclusiveError('Probe completion carried no answer')
    }
    return /\bgreen\b/i.test(answer) ? 'supported' : 'unsupported'
  }
  if (!contentRejectionStatuses.has(response.status)) {
    throw new ImageSupportInconclusiveError(`Probe failed with status ${response.status}`)
  }

  const control = await postChatCompletion(connection, model.model, 'Reply with the word ok.', signal)
  if (!control.ok) {
    throw new ImageSupportInconclusiveError(`Probe control request failed with status ${control.status}`)
  }
  return 'unsupported'
}
