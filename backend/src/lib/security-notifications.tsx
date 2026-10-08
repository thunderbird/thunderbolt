/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { sendEmail, shouldSkipEmail } from '@/lib/resend'
import { getEmailI18n } from '@/emails/i18n'
import { SecurityAlertEmail } from '@/emails/security-alert'
import { SecurityCodeEmail } from '@/emails/security-code'
import type { StepUpAction } from '@/lib/step-up-otp'
import type { AppLocale } from '@shared/i18n/locales'

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
  sendStepUpCode: (params: {
    action: StepUpAction
    email: string
    code: string
    deviceName: string
    locale: AppLocale
  }) => Promise<void>
  sendRecoveryPhraseChanged: (params: { email: string; deviceName: string; locale: AppLocale }) => Promise<void>
  sendDeviceApproved: (params: {
    email: string
    deviceName: string
    approverName: string
    locale: AppLocale
  }) => Promise<void>
  sendRecoveryPhraseUsed: (params: { email: string; deviceName: string; locale: AppLocale }) => Promise<void>
  sendBridgeConnected: (params: { email: string; deviceName: string; locale: AppLocale }) => Promise<void>
  sendEncryptionSetUp: (params: {
    email: string
    deviceName: string
    upgraded: boolean
    locale: AppLocale
  }) => Promise<void>
}

const sendAlert = async (
  label: string,
  to: string,
  i18n: I18n,
  preview: string,
  body: string,
  guidance: string,
): Promise<void> => {
  console.info(`📧 Sending ${label} email`)
  if (shouldSkipEmail()) {
    console.info(`📝 [DEV] Would send ${label} email`)
    return
  }
  const data = await sendEmail({
    to,
    subject: preview,
    react: <SecurityAlertEmail i18n={i18n} preview={preview} body={body} guidance={guidance} />,
  })
  console.info(`✅ ${label} email sent. ID: ${data?.id}`)
}

const revokeGuidance = (i18n: I18n): string =>
  i18n._({
    id: 'If this wasn’t you, revoke that device from Settings → Devices and change your recovery phrase immediately.',
  })

type StepUpCopy = { subject: string; body: string; guidance: string }

/**
 * Prose per step-up action. Exhaustive, so a new action will not compile until
 * its copy exists. The ids must stay literal here: the extractor cannot follow
 * a variable id, and only `src/emails` and this file are in the email catalog.
 */
export const stepUpCopy: Record<StepUpAction, (i18n: I18n, deviceName: string) => StepUpCopy> = {
  'recovery-phrase-change': (i18n, deviceName) => ({
    subject: i18n._({ id: 'Confirm your recovery phrase change' }),
    body: i18n._({
      id: 'A recovery phrase change was requested from device “{deviceName}”. Enter this code in the app to continue.',
      values: { deviceName },
    }),
    guidance: i18n._({ id: 'If this wasn’t you, don’t enter the code — revoke that device from Settings → Devices.' }),
  }),
  'account-deletion': (i18n, deviceName) => ({
    subject: i18n._({ id: 'Confirm your account deletion' }),
    body: i18n._({
      id: 'Deletion of your account was requested from device “{deviceName}”. Enter this code in the app to continue. Everything on our servers will be erased and cannot be recovered.',
      values: { deviceName },
    }),
    guidance: i18n._({
      id: 'If this wasn’t you, don’t enter the code — sign out of that device and change your sign-in method immediately.',
    }),
  }),
}

export const securityNotifications: SecurityNotifications = {
  async sendStepUpCode({ action, email, code, deviceName, locale }) {
    console.info(`📧 Sending ${action} step-up code email`)
    if (shouldSkipEmail()) {
      // Same dev affordance as sign-in (`sendSignInEmail`): no email goes out,
      // so the terminal is the inbox.
      console.info(`🔢 [DEV] Step-up code: ${code}`)
      return
    }
    const i18n = getEmailI18n(locale)
    const { subject, body, guidance } = stepUpCopy[action](i18n, deviceName)
    const data = await sendEmail({
      to: email,
      subject,
      react: <SecurityCodeEmail i18n={i18n} code={code} preview={subject} body={body} guidance={guidance} />,
    })
    console.info(`✅ Step-up code email sent. ID: ${data?.id}`)
  },

  sendRecoveryPhraseChanged: ({ email, deviceName, locale }) => {
    const i18n = getEmailI18n(locale)
    return sendAlert(
      'recovery-phrase-changed',
      email,
      i18n,
      i18n._({ id: 'Your recovery phrase was changed' }),
      i18n._({
        id: 'Your Thunderbolt recovery phrase was changed from device “{deviceName}”. Your previous phrase no longer works.',
        values: { deviceName },
      }),
      revokeGuidance(i18n),
    )
  },

  sendDeviceApproved: ({ email, deviceName, approverName, locale }) => {
    const i18n = getEmailI18n(locale)
    return sendAlert(
      'device-approved',
      email,
      i18n,
      i18n._({ id: 'A new device was added to your account' }),
      i18n._({
        id: 'Device “{deviceName}” was approved from device “{approverName}” and now has access to your encrypted data.',
        values: { deviceName, approverName },
      }),
      i18n._({ id: 'If this wasn’t you, revoke it from Settings → Devices.' }),
    )
  },

  sendRecoveryPhraseUsed: ({ email, deviceName, locale }) => {
    const i18n = getEmailI18n(locale)
    return sendAlert(
      'recovery-phrase-used',
      email,
      i18n,
      i18n._({ id: 'Your recovery phrase was used' }),
      i18n._({
        id: 'Device “{deviceName}” was connected to your account using your recovery phrase.',
        values: { deviceName },
      }),
      i18n._({
        id: 'If this wasn’t you, your recovery phrase is compromised — revoke that device from Settings → Devices and change your phrase immediately.',
      }),
    )
  },

  sendBridgeConnected: ({ email, deviceName, locale }) => {
    const i18n = getEmailI18n(locale)
    return sendAlert(
      'bridge-connected',
      email,
      i18n,
      i18n._({ id: 'A bridge device was connected to your account' }),
      i18n._({
        id: 'Bridge device “{deviceName}” was connected to your account and now has access to your encrypted data.',
        values: { deviceName },
      }),
      i18n._({ id: 'If this wasn’t you, revoke it from Settings → Devices.' }),
    )
  },

  sendEncryptionSetUp: ({ email, deviceName, upgraded, locale }) => {
    const i18n = getEmailI18n(locale)
    return sendAlert(
      'encryption-set-up',
      email,
      i18n,
      upgraded
        ? i18n._({ id: 'Your account encryption was upgraded' })
        : i18n._({ id: 'End-to-end encryption was set up' }),
      upgraded
        ? i18n._({
            id: 'Your account was upgraded to the new encryption scheme from device “{deviceName}”, and a new recovery phrase was created.',
            values: { deviceName },
          })
        : i18n._({
            id: 'End-to-end encryption was set up for your account from device “{deviceName}”, and a recovery phrase was created.',
            values: { deviceName },
          }),
      i18n._({ id: 'If this wasn’t you, secure your account now: revoke unknown devices from Settings → Devices.' }),
    )
  },
}
