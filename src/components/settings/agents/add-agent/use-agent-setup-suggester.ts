/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { createModel } from '@/ai/fetch'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import {
  getSystemTinfoilClient,
  getTinfoilClient,
  evictSystemTinfoilClient,
  evictUserTinfoilClient,
} from '@/ai/tinfoil-client'
import { createSystemTinfoilFetch, fetchTinfoil } from '@/ai/tinfoil-fetch'
import { submitInferenceUsageReceipt } from '@/ai/inference-usage-receipt'
import { inferenceUsageReceiptHeader } from '@shared/inference-usage'
import { useDatabase, useHttpClient } from '@/contexts'
import { getAvailableModels, getSelectedModelQuery } from '@/dal'
import { useProxyFetchGetter } from '@/lib/proxy-fetch-context'
import { needsApiKey } from '@/settings/models/model-policy'
import type { Model } from '@/types'
import { generateAgentSetup, type AgentSetupSuggester } from './agent-setup-suggestion'

/** Resolve current model credentials at request time; never include them in the suggestion prompt. */
export const useAgentSetupSuggester = (): AgentSetupSuggester => {
  const db = useDatabase()
  const httpClient = useHttpClient()
  const getProxyFetch = useProxyFetchGetter()
  const { i18n } = useLingui()

  return async (input, signal) => {
    const [selected, available] = await Promise.all([getSelectedModelQuery(db).all(), getAvailableModels(db).all()])
    const models = available as Model[]
    const modelConfig =
      models.find((model) => model.id === selected[0]?.id && !needsApiKey(model)) ??
      models.find((model) => !needsApiKey(model))
    if (!modelConfig) {
      throw new Error('No configured model available for agent setup')
    }
    signal.throwIfAborted()
    if (modelConfig.provider === 'tinfoil') {
      const managed = modelConfig.isSystem === 1
      const client = await (managed ? getSystemTinfoilClient() : getTinfoilClient())
      signal.throwIfAborted()
      const transport = managed
        ? createSystemTinfoilFetch(client, modelConfig.model, evictSystemTinfoilClient)
        : (input: RequestInfo | URL, init?: RequestInit) => fetchTinfoil(client, input, init, evictUserTinfoilClient)
      const provider = createOpenAICompatible({
        name: 'tinfoil',
        baseURL: client.getBaseURL()!,
        apiKey: managed ? 'thunderbolt-managed' : modelConfig.apiKey!,
        fetch: Object.assign(transport, { preconnect: async () => false }),
      })
      return generateAgentSetup(provider(modelConfig.model), input, signal, i18n.locale, {
        providerOptions: {
          tinfoil:
            modelConfig.model === 'deepseek-v4-1-flash'
              ? { chat_template_kwargs: { thinking: false } }
              : { thinking: { type: 'disabled' } },
        },
        onFinish: async ({ usage, response }) => {
          const receipt = response.headers?.[inferenceUsageReceiptHeader.toLowerCase()]
          if (!managed || !receipt || usage.inputTokens === undefined || usage.outputTokens === undefined) {
            return
          }
          try {
            await submitInferenceUsageReceipt(
              {
                receipt,
                promptTokens: usage.inputTokens,
                completionTokens: usage.outputTokens,
                totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens,
              },
              httpClient,
            )
          } catch (error) {
            console.error('Failed to record agent setup usage', error)
          }
        },
      })
    }
    const model = await createModel(modelConfig, getProxyFetch)
    signal.throwIfAborted()
    return generateAgentSetup(model, input, signal, i18n.locale)
  }
}
