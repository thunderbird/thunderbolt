/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Section, Text } from 'react-email'
import { EmailLayout } from './email-layout'
import { getEmailI18n } from './i18n'

type SecurityCodeEmailProps = {
  code: string
  deviceName: string
}

/**
 * Step-up verification code (THU-875): sent when a device asks to change the
 * account's recovery phrase. The code is the proof-of-inbox the rotate route
 * requires before it accepts a recovery re-anchor.
 *
 * Content is English-only for now; the layout chrome still needs an `i18n` for
 * `<Html lang>` and header/footer, so the source-locale catalog is passed. Add
 * locale threading through `SecurityNotifications` when these get localized.
 */
export const SecurityCodeEmail = ({ code, deviceName }: SecurityCodeEmailProps) => (
  <EmailLayout i18n={getEmailI18n('en')} preview="Confirm your recovery phrase change">
    <Section className="bg-white border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-sm text-tb-text m-0 mb-6">
        A recovery phrase change was requested from device “{deviceName}”. Enter this code in the app to continue.
      </Text>
      <Text className="text-2xl font-semibold text-tb-text m-0 mb-6">{code}</Text>
      <Text className="text-sm text-tb-text m-0">
        If this wasn’t you, don’t enter the code — revoke that device from Settings → Devices.
      </Text>
    </Section>
  </EmailLayout>
)

SecurityCodeEmail.PreviewProps = {
  code: '88299917',
  deviceName: 'MacBook Pro',
} satisfies SecurityCodeEmailProps

export default SecurityCodeEmail
