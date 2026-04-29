/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Section, Text } from '@react-email/components'
import { EmailLayout } from './email-layout'

export const WaitlistReminderEmail = () => (
  <EmailLayout preview="You're already on the waitlist!">
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">You're already on the waitlist!</Text>
      <Text className="text-sm text-tb-text m-0 mb-6">
        Good news — you're already on the Thunderbolt waitlist. No need to sign up again! We're working hard to get you
        access as soon as possible. We'll send you an email when it's your turn to join.
      </Text>
      <Text className="text-sm text-tb-text m-0">The Thunderbolt Team</Text>
    </Section>
  </EmailLayout>
)

export default WaitlistReminderEmail
