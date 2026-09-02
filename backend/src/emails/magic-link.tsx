/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { Button, Section, Text } from 'react-email'
import { EmailLayout } from './email-layout'
import { getEmailI18n } from './i18n'

type MagicLinkEmailProps = {
  i18n: I18n
  code: string
  magicLinkUrl: string
}

export const magicLinkSubject = (i18n: I18n) => i18n._({ id: 'Your Thunderbolt verification code' })

export const MagicLinkEmail = ({ i18n, code, magicLinkUrl }: MagicLinkEmailProps) => (
  <EmailLayout i18n={i18n} preview={i18n._({ id: 'Sign in to Thunderbolt' })}>
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-sm text-tb-text m-0 mb-6">
        {i18n._({ id: 'Use the code below to sign in, or click the button.' })}
      </Text>
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">{code}</Text>
      <Button
        href={magicLinkUrl}
        className="bg-tb-button text-white text-sm font-medium rounded-xl px-6 py-2.5 box-border"
      >
        {i18n._({ id: 'Sign In' })}
      </Button>
    </Section>
  </EmailLayout>
)

MagicLinkEmail.PreviewProps = {
  i18n: getEmailI18n('en'),
  code: '882999',
  magicLinkUrl: 'https://app.thunderbolt.io/auth/verify?email=user@example.com&otp=882999',
} satisfies MagicLinkEmailProps

export default MagicLinkEmail
