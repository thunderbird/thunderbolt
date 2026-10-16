/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { AppLocale } from '@shared/i18n/locales'
import { sendEmail, shouldSkipEmail } from '@/lib/resend'
import { getEmailI18n } from '@/emails/i18n'
import { MagicLinkEmail, magicLinkSubject } from '@/emails/magic-link'

/** Tauri app origins - always included: `tauri://` on macOS/iOS, `http://tauri.localhost` on Android/Windows */
const tauriOrigins = ['tauri://localhost', 'http://tauri.localhost']

/** Default trusted origins for development */
const defaultTrustedOrigins = [
  'http://localhost:1420', // Vite dev server
  ...tauriOrigins,
]

/**
 * Parse trusted origins from environment variable or use defaults
 * Always includes the Tauri app origins
 */
export const parseTrustedOrigins = (envValue?: string): string[] => {
  const origins = envValue?.split(',').filter(Boolean)
  const baseOrigins = origins && origins.length > 0 ? origins : defaultTrustedOrigins
  const missingTauriOrigins = tauriOrigins.filter((origin) => !baseOrigins.includes(origin))
  return missingTauriOrigins.length > 0 ? [...baseOrigins, ...missingTauriOrigins] : baseOrigins
}

/**
 * Build a verify URL pointing to the SPA's `/auth/verify` route. The host is always
 * the app URL — web users open it in the browser, and iOS/Android Universal Links /
 * App Links route the same URL into the native app when installed.
 */
export const buildVerifyUrl = (appUrl: string, email: string, otp: string, challengeToken?: string): string => {
  const params = new URLSearchParams({ email, otp })
  if (challengeToken) {
    params.set('challengeToken', challengeToken)
  }
  return `${appUrl}/auth/verify?${params.toString()}`
}

type SendSignInEmailParams = {
  email: string
  otp: string
  verifyUrl: string
  locale: AppLocale
}

/** Send sign-in email with both OTP code and a clickable link. */
export const sendSignInEmail = async ({ email, otp, verifyUrl, locale }: SendSignInEmailParams): Promise<void> => {
  if (shouldSkipEmail()) {
    console.info(`🔗 [DEV] Verify URL (no email sent): ${verifyUrl}`)
    console.info(`🔢 [DEV] OTP code: ${otp}`)
    return
  }

  const i18n = getEmailI18n(locale)
  const data = await sendEmail({
    to: email,
    subject: magicLinkSubject(i18n),
    react: <MagicLinkEmail i18n={i18n} code={otp} magicLinkUrl={verifyUrl} />,
  })

  console.info(`✅ Sign-in email sent successfully. ID: ${data?.id}`)
}
