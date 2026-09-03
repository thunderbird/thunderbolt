/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { Section, Text } from 'react-email'
import { EmailLayout } from './email-layout'
import { getEmailI18n } from './i18n'

type WaitlistJoinedEmailProps = {
  i18n: I18n
}

export const waitlistJoinedSubject = (i18n: I18n) => i18n._({ id: "You're on the Thunderbolt waitlist!" })

export const WaitlistJoinedEmail = ({ i18n }: WaitlistJoinedEmailProps) => (
  <EmailLayout i18n={i18n} preview={waitlistJoinedSubject(i18n)}>
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">{i18n._({ id: 'Thanks for signing up!' })}</Text>
      <Text className="text-sm text-tb-text m-0 mb-6">
        {i18n._({
          id: "You've been added to the Thunderbolt waitlist. We're working hard to get you access as soon as possible. We'll send you another email when it's your turn to join.",
        })}
      </Text>
      <Text className="text-sm text-tb-text m-0">{i18n._({ id: 'The Thunderbolt Team' })}</Text>
    </Section>
  </EmailLayout>
)

WaitlistJoinedEmail.PreviewProps = {
  i18n: getEmailI18n('en'),
} satisfies WaitlistJoinedEmailProps

export default WaitlistJoinedEmail
