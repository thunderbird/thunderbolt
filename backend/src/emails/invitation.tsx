/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { Button, Section, Text } from 'react-email'
import { EmailLayout, emailAppName } from './email-layout'
import { getEmailI18n } from './i18n'

type InvitationEmailProps = {
  i18n: I18n
  inviteUrl: string
}

export const invitationSubject = (i18n: I18n) =>
  i18n._({ id: "You're invited to {appName}", values: { appName: emailAppName() } })

export const InvitationEmail = ({ i18n, inviteUrl }: InvitationEmailProps) => (
  <EmailLayout i18n={i18n} preview={invitationSubject(i18n)}>
    <Section className="bg-tb-card border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-sm text-tb-card-text m-0 mb-6">
        {i18n._({
          id: "You've been invited to join {appName}. Accept the invitation to sign in with this email address.",
          values: { appName: emailAppName() },
        })}
      </Text>
      <Button
        href={inviteUrl}
        className="bg-tb-button text-tb-button-text text-sm font-medium rounded-xl px-6 py-2.5 box-border"
      >
        {i18n._({ id: 'Accept invitation' })}
      </Button>
      <Text className="text-sm text-tb-card-text m-0 mt-6">
        {i18n._({
          id: "This invitation expires in one week. If you weren't expecting it, you can ignore this email.",
        })}
      </Text>
    </Section>
  </EmailLayout>
)

InvitationEmail.PreviewProps = {
  i18n: getEmailI18n('en'),
  inviteUrl: 'https://app.thunderbolt.io/invite/preview-token',
} satisfies InvitationEmailProps

export default InvitationEmail
