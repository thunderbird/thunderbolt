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
  deviceName: string
}

/**
 * Step-up verification code (THU-875): sent when a device asks to change the
 * account's recovery phrase. The code is the proof-of-inbox the rotate route
 * requires before it accepts a recovery re-anchor. Prose is rendered against the
 * recipient's locale via the passed-in `i18n`.
 */
export const SecurityCodeEmail = ({ i18n, code, deviceName }: SecurityCodeEmailProps) => (
  <EmailLayout i18n={i18n} preview={i18n._({ id: 'Confirm your recovery phrase change' })}>
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-sm text-tb-text m-0 mb-6">
        {i18n._({
          id: 'A recovery phrase change was requested from device “{deviceName}”. Enter this code in the app to continue.',
          values: { deviceName },
        })}
      </Text>
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">{code}</Text>
      <Text className="text-sm text-tb-text m-0">
        {i18n._({ id: 'If this wasn’t you, don’t enter the code — revoke that device from Settings → Devices.' })}
      </Text>
    </Section>
  </EmailLayout>
)

SecurityCodeEmail.PreviewProps = {
  i18n: getEmailI18n('en'),
  code: '88299917',
  deviceName: 'MacBook Pro',
} satisfies SecurityCodeEmailProps

export default SecurityCodeEmail
