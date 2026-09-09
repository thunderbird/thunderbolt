/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { Section, Text } from 'react-email'
import { EmailLayout } from './email-layout'
import { getEmailI18n } from './i18n'

type WaitlistNotReadyEmailProps = {
  i18n: I18n
}

export const waitlistNotReadySubject = (i18n: I18n) => i18n._({ id: "You're on the Thunderbolt waitlist!" })

export const WaitlistNotReadyEmail = ({ i18n }: WaitlistNotReadyEmailProps) => (
  <EmailLayout i18n={i18n} preview={waitlistNotReadySubject(i18n)}>
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">{i18n._({ id: 'Not quite ready yet!' })}</Text>
      <Text className="text-sm text-tb-text m-0 mb-6">
        {i18n._({
          id: "We noticed you tried to sign in to Thunderbolt. You're on our waitlist, but we're not quite ready for you yet. Don't worry — we're working hard to get you access as soon as possible. We'll send you an email when it's your turn to join.",
        })}
      </Text>
      <Text className="text-sm text-tb-text m-0">{i18n._({ id: 'The Thunderbolt Team' })}</Text>
    </Section>
  </EmailLayout>
)

WaitlistNotReadyEmail.PreviewProps = {
  i18n: getEmailI18n('en'),
} satisfies WaitlistNotReadyEmailProps

export default WaitlistNotReadyEmail
