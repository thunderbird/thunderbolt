/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

import { fetch } from '@/lib/fetch'
import { http } from '@/lib/http'
import { normalizeOpenAiBaseUrl } from '@/lib/openai-base-url'
import type { AvailableModel } from './model-catalog'

/** One row from Ollama `GET /api/tags` (validated per entry). */
export const ollamaTagModelSchema = z.object({
  name: z.string().min(1),
  model: z.string().optional(),
  details: z
    .object({
      context_length: z.number().positive().optional(),
      family: z.string().optional(),
      parameter_size: z.string().optional(),
    })
    .optional(),
  capabilities: z.array(z.string()).optional(),
})

export type OllamaTagModel = z.infer<typeof ollamaTagModelSchema>

/**
 * Envelope for `GET /api/tags`. Entries stay `unknown` so one malformed tag
 * can be skipped without failing the whole catalog.
 */
export const ollamaTagsResponseSchema = z.object({
  models: z.array(z.unknown()),
})

/**
 * Strips the OpenAI-compat `/v1` suffix so the native Ollama `/api/tags`
 * route resolves against the same origin the user typed into the Custom URL
 * field.
 */
export const resolveOllamaOrigin = (openAiCompatibleUrl: string): string | null => {
  try {
    const normalized = normalizeOpenAiBaseUrl(openAiCompatibleUrl)
    const origin = normalized.replace(/\/v1$/i, '')
    // Reject empty / scheme-only leftovers from malformed input.
    const parsed = new URL(origin)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? origin : null
  } catch {
    return null
  }
}

/**
 * Heuristic gate before probing `/api/tags`.
 *
 * Matches default Ollama port `11434`, or a hostname containing `ollama`
 * (e.g. docker service `http://ollama/v1`). Intentionally incomplete: Ollama
 * on an uncommon port/host still works via `/v1/models`, just without rich
 * capability fields. That trade-off avoids an extra failed request for every
 * non-Ollama Custom endpoint (llama.cpp, corporate OpenAI-compat gateways).
 */
export const isLikelyOllamaBaseUrl = (url: string | undefined): boolean => {
  if (!url) {
    return false
  }
  try {
    const parsed = new URL(normalizeOpenAiBaseUrl(url))
    if (parsed.port === '11434') {
      return true
    }
    return /\bollama\b/i.test(parsed.hostname)
  } catch {
    return false
  }
}

/** Maps Ollama capability strings + detail fields onto Thunderbolt catalog fields. */
export const mapOllamaTagToAvailableModel = (tag: OllamaTagModel): AvailableModel => {
  const capabilities = new Set((tag.capabilities ?? []).map((capability) => capability.toLowerCase()))
  const contextWindow = tag.details?.context_length
  return {
    id: tag.name,
    name: tag.name,
    supports_tools: capabilities.has('tools'),
    supports_thinking: capabilities.has('thinking'),
    supports_vision: capabilities.has('vision'),
    context_window: typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : null,
  }
}

/**
 * Fetches the native Ollama model list.
 *
 * Returns `null` when the probe should soft-fail (network error, non-2xx via
 * http client, or body that is not Ollama-shaped) so callers fall back to
 * `/v1/models`. Soft-fail is intentional for an optional capability probe —
 * loud throw would break Custom-provider add flows for every non-Ollama URL
 * that still matched the heuristic.
 */
export const fetchOllamaTagsCatalog = async (origin: string): Promise<AvailableModel[] | null> => {
  try {
    const raw: unknown = await http.get(`${origin}/api/tags`, { fetch }).json<unknown>()
    const envelope = ollamaTagsResponseSchema.safeParse(raw)
    if (!envelope.success) {
      console.error('Ollama /api/tags response failed schema validation:', envelope.error)
      return null
    }

    const models: AvailableModel[] = []
    for (const entry of envelope.data.models) {
      const tag = ollamaTagModelSchema.safeParse(entry)
      if (!tag.success) {
        console.error('Skipping malformed Ollama tag entry:', tag.error)
        continue
      }
      models.push(mapOllamaTagToAvailableModel(tag.data))
    }

    if (models.length === 0) {
      return null
    }

    return models.sort((left, right) => left.id.localeCompare(right.id))
  } catch (error) {
    console.error('Ollama /api/tags probe failed:', error)
    return null
  }
}

/**
 * When the Custom URL looks like Ollama, prefer `/api/tags` (tools, thinking,
 * vision, context length). Returns `null` when the probe should be skipped or
 * failed so the OpenAI-compat catalog path can take over.
 */
export const tryFetchOllamaCatalog = async (url: string | undefined): Promise<AvailableModel[] | null> => {
  if (!url || !isLikelyOllamaBaseUrl(url)) {
    return null
  }
  const origin = resolveOllamaOrigin(url)
  if (!origin) {
    return null
  }
  return fetchOllamaTagsCatalog(origin)
}
