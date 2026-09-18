/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { Section, Text } from 'react-email'
import { EmailLayout } from './email-layout'
import { getEmailI18n } from './i18n'

type WaitlistReminderEmailProps = {
  i18n: I18n
}

export const waitlistReminderSubject = (i18n: I18n) => i18n._({ id: "You're already on the waitlist!" })

export const WaitlistReminderEmail = ({ i18n }: WaitlistReminderEmailProps) => (
  <EmailLayout i18n={i18n} preview={waitlistReminderSubject(i18n)}>
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">
        {i18n._({ id: "You're already on the waitlist!" })}
      </Text>
      <Text className="text-sm text-tb-text m-0 mb-6">
        {i18n._({
          id: "Good news — you're already on the Thunderbolt waitlist. No need to sign up again! We're working hard to get you access as soon as possible. We'll send you an email when it's your turn to join.",
        })}
      </Text>
      <Text className="text-sm text-tb-text m-0">{i18n._({ id: 'The Thunderbolt Team' })}</Text>
    </Section>
  </EmailLayout>
)

WaitlistReminderEmail.PreviewProps = {
  i18n: getEmailI18n('en'),
} satisfies WaitlistReminderEmailProps

export default WaitlistReminderEmail
