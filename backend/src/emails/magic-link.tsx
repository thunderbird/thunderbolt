/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button, Section, Text } from '@react-email/components'
import { EmailLayout } from './email-layout'

type MagicLinkEmailProps = {
  code: string
  magicLinkUrl: string
}

export const MagicLinkEmail = ({ code, magicLinkUrl }: MagicLinkEmailProps) => (
  <EmailLayout preview={`Thunderbolt Verification Code: ${code}`}>
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-sm text-tb-text m-0 mb-6">Use the code below to sign in, or click the button.</Text>
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">{code}</Text>
      <Button
        href={magicLinkUrl}
        className="bg-tb-button text-white text-sm font-medium rounded-xl px-6 py-2.5 box-border"
      >
        Sign In
      </Button>
    </Section>
  </EmailLayout>
)

MagicLinkEmail.PreviewProps = {
  code: '882999',
  magicLinkUrl: 'https://app.thunderbolt.io/auth/verify?email=user@example.com&otp=882999',
} satisfies MagicLinkEmailProps

export default MagicLinkEmail
