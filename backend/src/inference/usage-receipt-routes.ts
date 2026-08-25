/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { InferenceUsageReceiptRequest } from '@shared/inference-usage'
import { Elysia, type AnyElysia } from 'elysia'
import { z } from 'zod'
import type { InferenceLogger } from './client'
import { verifyInferenceUsageReceipt } from './usage-receipt'
import {
  InferenceCostOverflowError,
  type InferenceDatabase,
  InferenceTokenCountOutOfRangeError,
  recordInferenceUsage,
} from './usage-ledger'

export type ReceiptRouteOptions = Readonly<{
  auth: Auth
  database: InferenceDatabase
  secret: string
  nowSeconds?: () => number
  logger?: InferenceLogger
}>

const receiptRequestSchema: z.ZodType<InferenceUsageReceiptRequest> = z.object({
  receipt: z.string(),
  promptTokens: z.number().int().safe().nonnegative(),
  completionTokens: z.number().int().safe().nonnegative(),
  totalTokens: z.number().int().safe().nonnegative(),
})

/** Parse only the signed receipt and token counts from an untrusted request body. */
const parseReceiptRequest = async (request: Request): Promise<InferenceUsageReceiptRequest | null> => {
  try {
    const parsed = receiptRequestSchema.safeParse(await request.json())
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Emit only the receipt event identity and persistence outcome without affecting the response. */
const logReceiptOutcomeSafely = (
  logger: InferenceLogger | undefined,
  eventId: string,
  outcome: 'inserted' | 'duplicate',
): void => {
  try {
    logger?.info(
      { event: 'inference_usage_inserted', provider: 'tinfoil', model: 'glm-5-2', eventId, outcome },
      'Inference usage receipt stored',
    )
  } catch {
    // Persistence responses must not depend on telemetry availability.
  }
}

/** Create a truly body-free receipt endpoint response. */
const emptyResponse = (status: 204 | 400 | 403 | 503): Response => new Response(null, { status })

/** Create the authenticated managed GLM usage receipt endpoint. */
export const createInferenceUsageReceiptRoutes = (options: ReceiptRouteOptions): AnyElysia => {
  const { auth, database, logger, secret } = options
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000))

  return new Elysia({ prefix: '/inference-usage' })
    .onError(safeErrorHandler)
    .use(createAuthMacro(auth))
    .guard({ auth: true }, (app) =>
      app.post('/receipts', async ({ request, user }) => {
        const body = await parseReceiptRequest(request)
        if (!body) {
          return emptyResponse(400)
        }

        const claims = verifyInferenceUsageReceipt(body.receipt, secret, nowSeconds())
        if (!claims) {
          return emptyResponse(400)
        }
        if (claims.userId !== user.id) {
          return emptyResponse(403)
        }

        try {
          const outcome = await recordInferenceUsage(database, {
            id: claims.eventId,
            userId: user.id,
            counts: {
              promptTokens: body.promptTokens,
              completionTokens: body.completionTokens,
              totalTokens: body.totalTokens,
            },
            price: {
              provider: claims.provider,
              model: claims.model,
              inputNanoUsdPerToken: BigInt(claims.inputNanoUsdPerToken),
              outputNanoUsdPerToken: BigInt(claims.outputNanoUsdPerToken),
            },
          })
          logReceiptOutcomeSafely(logger, claims.eventId, outcome)
          return emptyResponse(204)
        } catch (error) {
          if (error instanceof InferenceTokenCountOutOfRangeError || error instanceof InferenceCostOverflowError) {
            return emptyResponse(400)
          }
          return emptyResponse(503)
        }
      }),
    )
}
