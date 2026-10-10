/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Auth } from '@/auth/elysia-plugin'
import { getSettings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { readBoundedJson } from '@/utils/request-body'
import { inferenceUsageReceiptPath, type InferenceUsageReceiptRequest } from '@shared/inference-usage'
import { Elysia, type AnyElysia } from 'elysia'
import { z } from 'zod'
import { logInferenceSafely, type InferenceLogger } from './client'
import { createMeteredRouteGuard } from './metered-route-guard'
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
  rateLimit?: AnyElysia
}>

const receiptRequestSchema: z.ZodType<InferenceUsageReceiptRequest> = z.object({
  receipt: z.string(),
  promptTokens: z.number().int().safe().nonnegative(),
  completionTokens: z.number().int().safe().nonnegative(),
  totalTokens: z.number().int().safe().nonnegative(),
})
const maxReceiptRequestBytes = 4_096

/** Parse only the signed receipt and token counts from an untrusted request body. */
const parseReceiptRequest = async (request: Request): Promise<InferenceUsageReceiptRequest | null> => {
  const read = await readBoundedJson(request, maxReceiptRequestBytes)
  if (!read.ok) {
    return null
  }
  const parsed = receiptRequestSchema.safeParse(read.value)
  return parsed.success ? parsed.data : null
}

/** Create a truly body-free receipt endpoint response. */
const emptyResponse = (status: 204 | 400 | 403 | 503): Response => new Response(null, { status })

/** Create the authenticated confidential managed usage receipt endpoint. */
export const createInferenceUsageReceiptRoutes = (options: ReceiptRouteOptions): AnyElysia => {
  const { auth, database, logger, rateLimit, secret } = options
  const { cliDeviceRegistrationEnabled, confidentialApiKeysEnabled } = getSettings()
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000))

  return new Elysia()
    .onError(safeErrorHandler)
    .use(
      createMeteredRouteGuard({ auth, database, cliDeviceRegistrationEnabled, confidentialApiKeysEnabled, rateLimit }),
    )
    .post(
      `/${inferenceUsageReceiptPath}`,
      async ({ request, user }) => {
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
          logInferenceSafely(
            logger,
            {
              event: 'inference_usage_inserted',
              provider: claims.provider,
              model: claims.model,
              eventId: claims.eventId,
              outcome,
            },
            'Inference usage receipt stored',
          )
          return emptyResponse(204)
        } catch (error) {
          if (error instanceof InferenceTokenCountOutOfRangeError || error instanceof InferenceCostOverflowError) {
            return emptyResponse(400)
          }
          try {
            logger?.info(
              {
                event: 'inference_usage_callback_failed',
                provider: claims.provider,
                model: claims.model,
                route: new URL(request.url).pathname,
              },
              'Inference usage callback failed',
            )
          } catch {
            // Telemetry failure must not change the body-free receipt response.
          }
          return emptyResponse(503)
        }
      },
      { parse: 'none' },
    )
}
