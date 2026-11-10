/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { InferenceTokenCounts } from '@/inference/usage-ledger'

/** Asks the enclave to report the request's token usage; see https://docs.tinfoil.sh/guides/proxy-server. */
export const tinfoilRequestUsageMetricsHeader = 'X-Tinfoil-Request-Usage-Metrics'
/** The enclave's usage report: a response header when unstreamed, an HTTP trailer after a stream's body. */
export const tinfoilUsageMetricsHeader = 'X-Tinfoil-Usage-Metrics'
/** The model the enclave must find in the sealed body, or it answers 400 before running inference. */
export const tinfoilModelHeader = 'X-Tinfoil-Model'

const countPattern = /^(?:0|[1-9][0-9]*)$/

/**
 * Read the token counts from a Tinfoil usage report such as
 * `prompt=32,completion=16,total=48,cached_prompt_tokens=0,model=deepseek-v4-1-flash,cost_usd=0.0000424`. Fields are
 * keyed, not positional, and Tinfoil may add more. Null unless `prompt`, `completion` and `total` are all safe integers.
 * `cached_prompt_tokens`, a part of `prompt` billed at the cached rate, counts only when it is a valid count no larger
 * than `prompt`; otherwise every prompt token is charged at the full input rate.
 */
export const parseTinfoilUsageMetrics = (report: string): InferenceTokenCounts | null => {
  const fields = new Map(
    report.split(',').map((pair) => {
      const [key, value = ''] = pair.split('=')
      return [key.trim(), value.trim()]
    }),
  )
  const count = (key: string): number | null => {
    const value = fields.get(key) ?? ''
    return countPattern.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
  }
  const promptTokens = count('prompt')
  const completionTokens = count('completion')
  const totalTokens = count('total')
  if (promptTokens === null || completionTokens === null || totalTokens === null) {
    return null
  }
  const cacheReadTokens = count('cached_prompt_tokens')
  if (cacheReadTokens === null || cacheReadTokens > promptTokens) {
    return { promptTokens, completionTokens, totalTokens }
  }
  return { promptTokens, completionTokens, totalTokens, cacheReadTokens }
}
