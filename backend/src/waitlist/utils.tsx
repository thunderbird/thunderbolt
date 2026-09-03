/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AppLocale } from '@shared/i18n/locales'
import { sendEmail, shouldSkipEmail } from '@/lib/resend'
import { getEmailI18n } from '@/emails/i18n'
import { WaitlistJoinedEmail, waitlistJoinedSubject } from '@/emails/waitlist-joined'
import { WaitlistReminderEmail, waitlistReminderSubject } from '@/emails/waitlist-reminder'
import { WaitlistNotReadyEmail, waitlistNotReadySubject } from '@/emails/waitlist-not-ready'
import { getWaitlistAutoApproveDomains, getSettings } from '@/config/settings'

/**
 * Check if an email domain is in the auto-approved list.
 */
export const isAutoApprovedDomain = (email: string): boolean => {
  const domain = email.split('@').pop()!.toLowerCase()
  return getWaitlistAutoApproveDomains(getSettings()).includes(domain)
}

type SendWaitlistEmailParams = {
  email: string
  locale: AppLocale
}

/**
 * Send email when user joins the waitlist.
 */
export const sendWaitlistJoinedEmail = async ({ email, locale }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending joined waitlist email')

  if (shouldSkipEmail()) {
    console.info('📝 [DEV] Would send joined waitlist email')
    return
  }

  const i18n = getEmailI18n(locale)
  const data = await sendEmail({
    to: email,
    subject: waitlistJoinedSubject(i18n),
    react: <WaitlistJoinedEmail i18n={i18n} />,
  })
  console.info(`✅ Joined waitlist email sent successfully. ID: ${data?.id}`)
}

/**
 * Send waitlist reminder email for users already on the waitlist.
 */
export const sendWaitlistReminderEmail = async ({ email, locale }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending waitlist reminder email')

  if (shouldSkipEmail()) {
    console.info('📝 [DEV] Would send waitlist reminder email')
    return
  }

  const i18n = getEmailI18n(locale)
  const data = await sendEmail({
    to: email,
    subject: waitlistReminderSubject(i18n),
    react: <WaitlistReminderEmail i18n={i18n} />,
  })
  console.info(`✅ Waitlist reminder sent successfully. ID: ${data?.id}`)
}

/**
 * Send "not ready yet" email when a pending waitlist user tries to sign in.
 */
export const sendWaitlistNotReadyEmail = async ({ email, locale }: SendWaitlistEmailParams): Promise<void> => {
  console.info('📧 Sending waitlist not-ready email')

  if (shouldSkipEmail()) {
    console.info('📝 [DEV] Would send waitlist not-ready email')
    return
  }

  const i18n = getEmailI18n(locale)
  const data = await sendEmail({
    to: email,
    subject: waitlistNotReadySubject(i18n),
    react: <WaitlistNotReadyEmail i18n={i18n} />,
  })
  console.info(`✅ Waitlist not-ready email sent successfully. ID: ${data?.id}`)
}
