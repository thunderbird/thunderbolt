/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { Section, Text } from 'react-email'
import { EmailLayout } from './email-layout'
import { getEmailI18n } from './i18n'

type SecurityCodeEmailProps = {
  i18n: I18n
  code: string
  preview: string
  body: string
  guidance: string
}

/**
 * Step-up verification code: the proof-of-inbox a gated route requires before
 * it will perform a sensitive action. Prose is passed in already resolved
 * against the recipient's locale — see `stepUpCopy` in `security-notifications`.
 */
export const SecurityCodeEmail = ({ i18n, code, preview, body, guidance }: SecurityCodeEmailProps) => (
  <EmailLayout i18n={i18n} preview={preview}>
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-sm text-tb-text m-0 mb-6">{body}</Text>
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">{code}</Text>
      <Text className="text-sm text-tb-text m-0">{guidance}</Text>
    </Section>
  </EmailLayout>
)

SecurityCodeEmail.PreviewProps = {
  i18n: getEmailI18n('en'),
  code: '88299917',
  preview: 'Confirm your recovery phrase change',
  body: 'A recovery phrase change was requested from device “MacBook Pro”. Enter this code in the app to continue.',
  guidance: 'If this wasn’t you, don’t enter the code — revoke that device from Settings → Devices.',
} satisfies SecurityCodeEmailProps

export default SecurityCodeEmail
