/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Section, Text } from 'react-email'
import { EmailLayout } from './email-layout'
import { getEmailI18n } from './i18n'

type SecurityAlertEmailProps = {
  preview: string
  body: string
  guidance: string
}

/**
 * Generic security notification (THU-875): recovery phrase changed, new device
 * approved, recovery phrase used, bridge connected, encryption set up. The
 * wording lives with each sender in `lib/security-notifications.tsx`.
 *
 * Content is English-only for now; the layout chrome still needs an `i18n` for
 * `<Html lang>` and header/footer, so the source-locale catalog is passed. Add
 * locale threading through `SecurityNotifications` when these get localized.
 */
export const SecurityAlertEmail = ({ preview, body, guidance }: SecurityAlertEmailProps) => (
  <EmailLayout i18n={getEmailI18n('en')} preview={preview}>
    <Section className="bg-white border border-solid border-tb-border rounded-2xl px-8 py-8">
      <Text className="text-sm text-tb-text m-0 mb-4">{body}</Text>
      <Text className="text-sm text-tb-text m-0">{guidance}</Text>
    </Section>
  </EmailLayout>
)

SecurityAlertEmail.PreviewProps = {
  preview: 'Your recovery phrase was changed',
  body: 'Your Thunderbolt recovery phrase was changed from device “MacBook Pro”. Your previous phrase no longer works.',
  guidance:
    'If this wasn’t you, revoke that device from Settings → Devices and change your recovery phrase immediately.',
} satisfies SecurityAlertEmailProps

export default SecurityAlertEmail
