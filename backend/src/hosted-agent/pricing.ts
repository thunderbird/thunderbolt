/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import type { ManagedAgentIdentity } from '@/inference/managed-models'
import type { InferencePrice, ManagedInferenceIdentity } from '@/inference/usage-ledger'

type Surcharge = Readonly<{ numerator: bigint; denominator: bigint }>

/**
 * Fireworks' Priority price as a multiple of the Standard price stored in `inference_prices`, per model. Each is
 * the same on input, cached input and output; https://docs.fireworks.ai/serverless/pricing.
 */
const fireworksPrioritySurcharges = new Map<string, Surcharge>([
  // Standard $1.40 / $0.26 / $4.40, Priority $1.75 / $0.325 / $5.50 per 1M.
  ['accounts/fireworks/models/glm-5p3', { numerator: 5n, denominator: 4n }],
  // Standard $0.30 / $0.06 / $1.20, Priority $0.45 / $0.09 / $1.80 per 1M.
  ['accounts/fireworks/models/minimax-m3', { numerator: 3n, denominator: 2n }],
])

const isPriorityPriced = ({ provider }: ManagedInferenceIdentity, settings: Settings) =>
  settings.agentFireworksServiceTier === 'priority' && provider === 'fireworks'

const getPrioritySurcharge = (model: string): Surcharge => {
  const surcharge = fireworksPrioritySurcharges.get(model)
  if (!surcharge) {
    throw new Error(
      `AGENT_FIREWORKS_SERVICE_TIER is "priority", but the Priority surcharge of AGENT_MODEL "${model}" is unknown, ` +
        'so its replies would be recorded below their cost. Use "standard", or add the model to ' +
        'fireworksPrioritySurcharges.',
    )
  }
  return surcharge
}

/**
 * Throws when the agent runs on Fireworks' Priority tier with a model whose Priority surcharge is unknown, so the
 * boot fails instead of every reply being recorded at the Standard price.
 */
export const assertServiceTierPriced = (identity: ManagedAgentIdentity, settings: Settings) => {
  if (isPriorityPriced(identity, settings)) {
    getPrioritySurcharge(identity.model)
  }
}

/**
 * The price a run records at. On Fireworks' Priority tier that is the stored Standard price times the model's
 * Priority surcharge, rounded down to the nano-dollar; every other model and tier records at the stored price.
 * An absent cache-read rate stays absent, since cache reads then bill at the already scaled input rate.
 */
export const priceForServiceTier = (price: InferencePrice, settings: Settings): InferencePrice => {
  if (!isPriorityPriced(price, settings)) {
    return price
  }
  const { numerator, denominator } = getPrioritySurcharge(price.model)
  const scale = (rate: bigint) => (rate * numerator) / denominator
  return {
    ...price,
    inputNanoUsdPerToken: scale(price.inputNanoUsdPerToken),
    outputNanoUsdPerToken: scale(price.outputNanoUsdPerToken),
    ...(price.cacheReadNanoUsdPerToken !== undefined && {
      cacheReadNanoUsdPerToken: scale(price.cacheReadNanoUsdPerToken),
    }),
  }
}
