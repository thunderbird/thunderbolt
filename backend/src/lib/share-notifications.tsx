/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ChatSharedEmail, chatSharedSubject } from '@/emails/chat-shared'
import { getEmailI18n } from '@/emails/i18n'
import { sendEmail, shouldSkipEmail } from '@/lib/resend'
import type { AppLocale } from '@shared/i18n/locales'

/**
 * Share emails. Injectable into `createShareRoutes` so tests assert sends
 * without `mock.module`, the same shape as `SecurityNotifications`. Callers fire
 * them after the share commits, so a mail failure never fails a share.
 */
export type ShareNotifications = {
  sendChatShared: (params: {
    to: string
    sharerName: string
    sharerEmail: string
    shareUrl: string
    /** The sharer's language: the request carrying it is the sharer's own. */
    locale: AppLocale
  }) => Promise<void>
}

export const shareNotifications: ShareNotifications = {
  sendChatShared: async ({ to, sharerName, sharerEmail, shareUrl, locale }) => {
    console.info('📧 Sending chat-shared email')
    if (shouldSkipEmail()) {
      console.info('📝 [DEV] Would send chat-shared email')
      return
    }
    const i18n = getEmailI18n(locale)
    const data = await sendEmail({
      to,
      subject: chatSharedSubject(i18n, sharerName),
      react: <ChatSharedEmail i18n={i18n} sharerName={sharerName} sharerEmail={sharerEmail} shareUrl={shareUrl} />,
    })
    console.info(`✅ chat-shared email sent. ID: ${data?.id}`)
  },
}
