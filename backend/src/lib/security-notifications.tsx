/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sendEmail, shouldSkipEmail } from '@/lib/resend'
import { SecurityAlertEmail } from '@/emails/security-alert'
import { SecurityCodeEmail } from '@/emails/security-code'

/**
 * Account security emails (THU-875). Every event where a device gains access to
 * the account — or the recovery anchor moves — notifies the account email
 * out-of-band. Email is the one channel an in-origin attacker cannot suppress.
 *
 * Injectable into `createEncryptionRoutes` so tests assert sends without
 * `mock.module` (same rationale as `AuthEmailDeps`). Callers fire-and-forget
 * AFTER their transaction commits: a mail failure must never abort or fail a
 * committed security operation.
 */
export type SecurityNotifications = {
  sendStepUpCode: (params: { email: string; code: string; deviceName: string }) => Promise<void>
  sendRecoveryPhraseChanged: (params: { email: string; deviceName: string }) => Promise<void>
  sendDeviceApproved: (params: { email: string; deviceName: string; approverName: string }) => Promise<void>
  sendRecoveryPhraseUsed: (params: { email: string; deviceName: string }) => Promise<void>
  sendBridgeConnected: (params: { email: string; deviceName: string }) => Promise<void>
  sendEncryptionSetUp: (params: { email: string; deviceName: string; upgraded: boolean }) => Promise<void>
}

const sendAlert = async (label: string, to: string, preview: string, body: string, guidance: string): Promise<void> => {
  console.info(`📧 Sending ${label} email`)
  if (shouldSkipEmail()) {
    console.info(`📝 [DEV] Would send ${label} email`)
    return
  }
  const data = await sendEmail({
    to,
    subject: preview,
    react: <SecurityAlertEmail preview={preview} body={body} guidance={guidance} />,
  })
  console.info(`✅ ${label} email sent. ID: ${data?.id}`)
}

const revokeGuidance =
  'If this wasn’t you, revoke that device from Settings → Devices and change your recovery phrase immediately.'

export const securityNotifications: SecurityNotifications = {
  async sendStepUpCode({ email, code, deviceName }) {
    console.info('📧 Sending step-up code email')
    if (shouldSkipEmail()) {
      // Same dev affordance as sign-in (`sendSignInEmail`): no email goes out,
      // so the terminal is the inbox.
      console.info(`🔢 [DEV] Step-up code: ${code}`)
      return
    }
    const data = await sendEmail({
      to: email,
      subject: 'Confirm your recovery phrase change',
      react: <SecurityCodeEmail code={code} deviceName={deviceName} />,
    })
    console.info(`✅ Step-up code email sent. ID: ${data?.id}`)
  },

  sendRecoveryPhraseChanged: ({ email, deviceName }) =>
    sendAlert(
      'recovery-phrase-changed',
      email,
      'Your recovery phrase was changed',
      `Your Thunderbolt recovery phrase was changed from device “${deviceName}”. Your previous phrase no longer works.`,
      revokeGuidance,
    ),

  sendDeviceApproved: ({ email, deviceName, approverName }) =>
    sendAlert(
      'device-approved',
      email,
      'A new device was added to your account',
      `Device “${deviceName}” was approved from device “${approverName}” and now has access to your encrypted data.`,
      'If this wasn’t you, revoke it from Settings → Devices.',
    ),

  sendRecoveryPhraseUsed: ({ email, deviceName }) =>
    sendAlert(
      'recovery-phrase-used',
      email,
      'Your recovery phrase was used',
      `Device “${deviceName}” was connected to your account using your recovery phrase.`,
      'If this wasn’t you, your recovery phrase is compromised — revoke that device from Settings → Devices and change your phrase immediately.',
    ),

  sendBridgeConnected: ({ email, deviceName }) =>
    sendAlert(
      'bridge-connected',
      email,
      'A bridge device was connected to your account',
      `Bridge device “${deviceName}” was connected to your account and now has access to your encrypted data.`,
      'If this wasn’t you, revoke it from Settings → Devices.',
    ),

  sendEncryptionSetUp: ({ email, deviceName, upgraded }) =>
    sendAlert(
      'encryption-set-up',
      email,
      upgraded ? 'Your account encryption was upgraded' : 'End-to-end encryption was set up',
      upgraded
        ? `Your account was upgraded to the new encryption scheme from device “${deviceName}”, and a new recovery phrase was created.`
        : `End-to-end encryption was set up for your account from device “${deviceName}”, and a recovery phrase was created.`,
      'If this wasn’t you, secure your account now: revoke unknown devices from Settings → Devices.',
    ),
}
