/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { loadInferencePrice, type InferenceDatabase } from '@/inference/usage-ledger'
import { defaultModels, type SharedModel } from '@shared/defaults/models'
import { randomBytes } from 'node:crypto'
import OpenAI from 'openai'
import { SecureClient } from 'tinfoil'
import { anthropicCompatBaseUrl } from './client'
import { resolveConfidentialManagedModel, resolveManagedDirectRuntime } from './managed-models'

export type ModelProbeFailureReason = 'no-text' | 'timeout' | 'upstream-error' | 'missing-price' | 'not-configured'
export type ModelProbeFailure = { model: string; reason: ModelProbeFailureReason }
export type ModelProbeDeps = {
  database: InferenceDatabase
  settings: Pick<Settings, 'anthropicApiKey' | 'tinfoilApiKey'>
  /** Transport for the Anthropic OpenAI-compatible client (tests inject a fake). */
  fetchFn: typeof fetch
  /** Attested Tinfoil transport; defaults to a fresh SecureClient per run. */
  confidentialTransport?: { fetch: typeof fetch; baseURL: string }
  logger?: { warn: (context: Record<string, string | number>, message: string) => void }
  /** Per-model deadline, default 20_000. */
  timeoutMs?: number
  /** Max models probed at once, default 3. */
  concurrency?: number
}

const modelProbeTimeoutMs = 20_000
const modelProbeConcurrency = 3
// A 256-token ceiling leaves room for reasoning models to answer; smaller budgets returned no text live.
const modelProbeMaxTokens = 256

/** Pair the encrypted transport with the enclave whose key was attested. */
const createConfidentialTransport = async () => {
  const secure = new SecureClient({ userCacheSecret: randomBytes(32).toString('hex') })
  await secure.ready()
  return { fetch: secure.fetch, baseURL: secure.getBaseURL()! }
}

/** Probe every shipped catalog model once; returns the failing ones (empty = all healthy). */
export const probeCatalogModels = async (deps: ModelProbeDeps): Promise<ModelProbeFailure[]> => {
  const { database, settings, fetchFn, timeoutMs = modelProbeTimeoutMs, concurrency = modelProbeConcurrency } = deps
  let confidentialTransport: Promise<NonNullable<ModelProbeDeps['confidentialTransport']>> | undefined
  const probe = async (model: SharedModel): Promise<ModelProbeFailure | null> => {
    const fail = (reason: ModelProbeFailureReason, error?: unknown): ModelProbeFailure => {
      deps.logger?.warn(
        {
          event: 'deep_health_model_probe_failed',
          model: model.model,
          reason,
          ...(error instanceof Error ? { errorName: error.name } : {}),
          ...(error instanceof OpenAI.APIError && error.status !== undefined ? { status: error.status } : {}),
        },
        'Model health probe failed',
      )
      return { model: model.model, reason }
    }
    const signal = AbortSignal.timeout(timeoutMs)
    const deadline = Promise.withResolvers<never>()
    const abort = () => deadline.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      const runtime = model.provider === 'thunderbolt' ? resolveManagedDirectRuntime(model.model) : undefined
      const identity = runtime
        ? { provider: runtime.provider, model: runtime.internalName }
        : model.provider === 'tinfoil' && model.isConfidential === 1
          ? resolveConfidentialManagedModel(model.model)
          : undefined
      if (!identity) {
        return fail('upstream-error')
      }
      const apiKey = runtime ? settings.anthropicApiKey : settings.tinfoilApiKey
      if (!apiKey.trim()) {
        return fail('not-configured')
      }
      if (!(await Promise.race([loadInferencePrice(database, identity), deadline.promise]))) {
        return fail('missing-price')
      }
      signal.throwIfAborted()
      const transport = runtime
        ? { fetch: fetchFn, baseURL: anthropicCompatBaseUrl }
        : (deps.confidentialTransport ??
          (await Promise.race([(confidentialTransport ??= createConfidentialTransport()), deadline.promise])))
      signal.throwIfAborted()
      const client = new OpenAI({
        apiKey,
        ...transport,
        maxRetries: 0,
      })
      const request: OpenAI.ChatCompletionCreateParamsNonStreaming & { thinking?: { type: 'disabled' } } = {
        model: identity.model,
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        stream: false,
        max_tokens: modelProbeMaxTokens,
      }
      if (!runtime) {
        request.thinking = { type: 'disabled' }
      }
      // SDK attestation cannot be cancelled; bound the wait. Its key-rotation recovery is not a completion retry.
      const response = await Promise.race([client.chat.completions.create(request, { signal }), deadline.promise])
      const content = response.choices[0]?.message?.content as
        | string
        | { type: string; text?: string }[]
        | null
        | undefined
      const text = Array.isArray(content)
        ? content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('')
        : content
      return text?.trim() ? null : fail('no-text')
    } catch (error) {
      return fail(signal.aborted ? 'timeout' : 'upstream-error', error)
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
  const queue = defaultModels.entries()
  const results: (ModelProbeFailure | null)[] = []
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (const [index, model] of queue) {
        results[index] = await probe(model)
      }
    }),
  )
  return results.filter((result): result is ModelProbeFailure => result !== null)
}
