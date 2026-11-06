/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { InferenceQuotaDecision } from './usage-ledger'

type ExceededInferenceQuotaDecision = Extract<InferenceQuotaDecision, { allowed: false }>

/** Create the stable response returned when canonical inference pricing is unavailable. */
export const createPriceUnavailableResponse = (): Response =>
  Response.json({ error: { code: 'INFERENCE_PRICE_UNAVAILABLE' } }, { status: 503 })

/** Create the stable response returned when a rolling inference quota is exhausted. */
export const createQuotaExceededResponse = (decision: ExceededInferenceQuotaDecision): Response =>
  Response.json({ error: { code: 'INFERENCE_QUOTA_EXCEEDED', window: decision.exceededWindow } }, { status: 429 })
