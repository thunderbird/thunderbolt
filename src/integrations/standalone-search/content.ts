/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { t } from '@lingui/core/macro'
import { z } from 'zod'
import type { HttpClient } from '@/lib/http'
import type { FetchContentData, FetchContentParams } from '@/integrations/thunderbolt-pro/schemas'
import { isPublicWebUrl, publicWebMediaUrl } from './url-policy'

const pageUrl = z.string().refine(isPublicWebUrl)
const exaContents = z.object({
  results: z.array(
    z.object({
      url: pageUrl,
      text: z.string(),
      title: z.string().nullish(),
      author: z.string().nullish(),
      publishedDate: z.string().nullish(),
      image: z.string().nullish(),
      favicon: z.string().nullish(),
    }),
  ),
})
const tavilyContents = z.object({
  results: z.array(
    z.object({
      url: pageUrl,
      raw_content: z.string(),
      favicon: z.string().nullish(),
    }),
  ),
})

// Allows the maximum requested text plus JSON escaping and metadata, without retaining arbitrary provider bodies.
const maxContentResponseBytes = 1024 * 1024

/** Enforces the response budget before JSON parsing, including chunked or decompressed bodies. */
const readContentResponse = async (response: Response, signal: AbortSignal): Promise<unknown> => {
  const tooLarge = () => new Error(t`The search provider returned too much content. Try another page.`)
  if (Number(response.headers.get('content-length')) > maxContentResponseBytes) {
    void response.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!response.body) {
    throw new Error(t`The search provider could not retrieve this page.`)
  }
  const reader = response.body.getReader()
  // Cancelling the reader also settles a pending read if a transport doesn't propagate the request signal to its body.
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    if (signal.aborted) {
      cancel()
      signal.throwIfAborted()
    }
    while (true) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) {
        return JSON.parse(chunks.join('') + decoder.decode())
      }
      bytes += value.byteLength
      if (bytes > maxContentResponseBytes) {
        void reader.cancel().catch(() => {})
        throw tooLarge()
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

/** Retrieve bounded evidence through fixed provider endpoints, never from model-controlled device URLs. */
export const fetchProviderContent = async (
  provider: 'exa' | 'tavily',
  apiKey: string,
  { url, max_length }: FetchContentParams,
  client: HttpClient,
  signal?: AbortSignal,
): Promise<FetchContentData> => {
  pageUrl.parse(url)
  const limit = Math.min(64000, Math.max(1, Math.floor(max_length ?? 16000)))
  const deadline = new AbortController()
  const timeout = setTimeout(() => deadline.abort(new DOMException('Request timed out', 'TimeoutError')), 30_000)
  const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  try {
    const response = await client.post(
      provider === 'exa' ? 'https://api.exa.ai/contents' : 'https://api.tavily.com/extract',
      {
        headers: provider === 'exa' ? { 'x-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` },
        json:
          provider === 'exa'
            ? { urls: [url], text: { maxCharacters: limit + 1 } }
            : { urls: [url], extract_depth: 'basic', format: 'markdown', include_favicon: true },
        credentials: 'omit',
        redirect: 'error',
        signal: requestSignal,
      },
    )
    const data = await readContentResponse(response, requestSignal)
    if (provider === 'exa') {
      const page = exaContents.parse(data).results[0]
      if (!page?.text.trim()) {
        throw new Error(t`The search provider could not retrieve this page.`)
      }
      return {
        url: page.url,
        title: page.title ?? null,
        text: page.text.slice(0, limit),
        isTruncated: page.text.length > limit,
        image: publicWebMediaUrl(page.image),
        favicon: publicWebMediaUrl(page.favicon),
        author: page.author ?? null,
        publishedDate: page.publishedDate ?? null,
      }
    }
    const page = tavilyContents.parse(data).results[0]
    if (!page?.raw_content.trim()) {
      throw new Error(t`The search provider could not retrieve this page.`)
    }
    return {
      url: page.url,
      title: null,
      text: page.raw_content.slice(0, limit),
      isTruncated: page.raw_content.length > limit,
      favicon: publicWebMediaUrl(page.favicon),
      image: null,
      author: null,
    }
  } finally {
    clearTimeout(timeout)
    deadline.abort()
  }
}
