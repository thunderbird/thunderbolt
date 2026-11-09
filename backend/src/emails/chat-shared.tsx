/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { Button, Section, Text } from 'react-email'
import { EmailLayout, emailAppName } from './email-layout'
import { getEmailI18n } from './i18n'

type ChatSharedEmailProps = {
  i18n: I18n
  sharerName: string
  sharerEmail: string
  shareUrl: string
}

/** Subject line of the chat-shared email, in the email's locale. */
export const chatSharedSubject = (i18n: I18n, sharerName: string) =>
  i18n._({ id: '{sharerName} shared a chat with you', values: { sharerName } })

/**
 * Tells a recipient a chat was shared with them. Names the sharer and nothing
 * else: the chat's title and content are end-to-end encrypted, so the server
 * could not put them here even if it wanted to.
 */
export const ChatSharedEmail = ({ i18n, sharerName, sharerEmail, shareUrl }: ChatSharedEmailProps) => (
  <EmailLayout i18n={i18n} preview={chatSharedSubject(i18n, sharerName)}>
    <Section className="bg-tb-card border border-solid border-tb-border rounded-2xl text-center px-8 py-8">
      <Text className="text-sm text-tb-card-text m-0 mb-6">
        {i18n._({
          id: '{sharerName} ({sharerEmail}) shared a chat with you on {appName}. Open it to read it — shared chats are view-only.',
          values: { sharerName, sharerEmail, appName: emailAppName() },
        })}
      </Text>
      <Button
        href={shareUrl}
        className="bg-tb-button text-tb-button-text text-sm font-medium rounded-xl px-6 py-2.5 box-border"
      >
        {i18n._({ id: 'Open shared chat' })}
      </Button>
    </Section>
  </EmailLayout>
)

ChatSharedEmail.PreviewProps = {
  i18n: getEmailI18n('en'),
  sharerName: 'Ada Lovelace',
  sharerEmail: 'ada@example.com',
  shareUrl: 'https://app.thunderbolt.io/shared/2f6c1a0e-5d1b-4c39-9f7e-1a2b3c4d5e6f',
} satisfies ChatSharedEmailProps

export default ChatSharedEmail
