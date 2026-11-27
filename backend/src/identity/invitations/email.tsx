/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getEmailI18n } from '@/emails/i18n'
import { InvitationEmail, invitationSubject } from '@/emails/invitation'
import { sendEmail, shouldSkipEmail } from '@/lib/resend'
import type { AppLocale } from '@shared/i18n/locales'

export type SendInvitationEmailParams = {
  email: string
  inviteUrl: string
  locale: AppLocale
}

/** Send an invitation with its accept link. */
export const sendInvitationEmail = async ({ email, inviteUrl, locale }: SendInvitationEmailParams) => {
  console.info('📧 Sending invitation email')

  if (shouldSkipEmail()) {
    console.info(`🔗 [DEV] Invitation URL for ${email} (no email sent): ${inviteUrl}`)
    return
  }

  const i18n = getEmailI18n(locale)
  const data = await sendEmail({
    to: email,
    subject: invitationSubject(i18n),
    react: <InvitationEmail i18n={i18n} inviteUrl={inviteUrl} />,
  })
  console.info(`✅ Invitation email sent successfully. ID: ${data?.id}`)
}
