/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { EmailDeliveryError, isEmailConfigured, sendEmail, type SendEmailParams } from '@/lib/resend'
import { safeErrorHandler } from '@/middleware/error-handling'
import type { RateLimitConsumer, RateLimitSet } from '@/middleware/rate-limit'
import { readBoundedJson } from '@/utils/request-body'
import { Elysia, type AnyElysia } from 'elysia'
import { createElement } from 'react'
import { contactBodySchema } from './body'
import { ContactEmail, contactEmailSubject } from './email'

/** Room for every field at its maximum length in three-byte characters, which is about 18 KB. */
const maxBodyBytes = 32_768

/** The single key of the deployment-wide contact budget: every visitor shares it. */
const emailBudgetKey = 'all'

export type ContactEmailService = {
  isConfigured: () => boolean
  send: (params: SendEmailParams) => Promise<unknown>
}

type ContactRoutesOptions = {
  settings: Pick<Settings, 'contactEmailTo'>
  /** Per-address limit, applied before the body is read. */
  ipRateLimit: AnyElysia
  /** Deployment-wide limit on emails sent. Per-address limits alone cannot bound a sender who rotates addresses. */
  emailBudget: RateLimitConsumer | null
  emailService?: ContactEmailService
}

/** Send website inquiries only to the operator's configured inbox. */
export const createContactRoutes = ({
  settings,
  ipRateLimit,
  emailBudget,
  emailService = { isConfigured: isEmailConfigured, send: sendEmail },
}: ContactRoutesOptions) =>
  new Elysia()
    .onError(safeErrorHandler)
    .use(ipRateLimit)
    .post(
      '/contact',
      async ({ request, set }) => {
        // A JSON content type forces a CORS preflight, so another site's form cannot post here.
        const mediaType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if (mediaType !== 'application/json') {
          set.status = 415
          return { error: 'Content-Type must be application/json.' }
        }
        const read = await readBoundedJson(request, maxBodyBytes)
        if (!read.ok) {
          const isTooLarge = read.reason === 'too_large'
          set.status = isTooLarge ? 413 : 400
          return { error: isTooLarge ? 'Request too large' : 'Invalid JSON' }
        }
        const parsed = contactBodySchema.safeParse(read.value)
        if (!parsed.success) {
          set.status = 422
          return { error: 'Please check your contact details.' }
        }
        if (!settings.contactEmailTo || !emailService.isConfigured()) {
          set.status = 503
          return { error: 'Contact form is currently unavailable. Please try again later.' }
        }
        // Charged on its own header set, so an accepted request still reports the per-address limit.
        const budget: RateLimitSet = { headers: {} }
        const exhausted = await emailBudget?.(emailBudgetKey, budget)
        if (exhausted) {
          set.status = 429
          Object.assign(set.headers, budget.headers)
          return exhausted
        }
        try {
          await emailService.send({
            to: settings.contactEmailTo,
            replyTo: parsed.data.email,
            subject: contactEmailSubject,
            react: createElement(ContactEmail, { submission: parsed.data }),
          })
        } catch (error) {
          if (!(error instanceof EmailDeliveryError)) {
            throw error
          }
          // Only the provider's code and status: its message text is not logged from a public form.
          console.error('[contact] Email delivery failed', {
            providerCode: error.providerCode,
            status: error.providerStatus,
          })
          set.status = 502
          return { error: 'Your message could not be sent. Please try again later.' }
        }
        return { success: true }
      },
      { parse: 'none' },
    )
