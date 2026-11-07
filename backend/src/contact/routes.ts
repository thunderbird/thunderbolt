/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Settings } from '@/config/settings'
import { EmailDeliveryError, isEmailConfigured, sendEmail } from '@/lib/resend'
import { safeErrorHandler } from '@/middleware/error-handling'
import { readBoundedJson } from '@/utils/request-body'
import { Elysia, type AnyElysia } from 'elysia'
import { createElement } from 'react'
import { contactBodySchema } from './body'
import { ContactEmail } from './email'

type ContactRoutesOptions = {
  settings: Pick<Settings, 'contactEmailTo'>
  ipRateLimit: AnyElysia
  emailService?: { isConfigured: typeof isEmailConfigured; send: typeof sendEmail }
}

/** Send website inquiries only to the operator's configured inbox. */
export const createContactRoutes = ({
  settings,
  ipRateLimit,
  emailService = { isConfigured: isEmailConfigured, send: sendEmail },
}: ContactRoutesOptions) =>
  new Elysia()
    .onError(safeErrorHandler)
    .use(ipRateLimit)
    .post(
      '/contact',
      async ({ request, set }) => {
        const mediaType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if (mediaType !== 'application/json') {
          set.status = 415
          return { error: 'Content-Type must be application/json.' }
        }
        const read = await readBoundedJson(request, 16_384)
        if (!read.ok) {
          set.status = read.reason === 'too_large' ? 413 : 400
          return { error: read.reason === 'too_large' ? 'Request too large' : 'Invalid JSON' }
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
        try {
          const accepted = await emailService.send({
            to: settings.contactEmailTo,
            replyTo: parsed.data.email,
            subject: 'Thunderbolt website inquiry',
            react: createElement(ContactEmail, { submission: parsed.data }),
          })
          if (accepted.id) {
            return { success: true }
          }
          console.error('[contact] Email delivery failed', { reason: 'missing_acceptance' })
        } catch (error) {
          console.error(
            '[contact] Email delivery failed',
            error instanceof EmailDeliveryError
              ? { providerCode: error.providerCode, status: error.providerStatus }
              : { reason: 'provider_request_failed' },
          )
        }
        set.status = 502
        return { error: 'Your message could not be sent. Please try again later.' }
      },
      { parse: 'none' },
    )
