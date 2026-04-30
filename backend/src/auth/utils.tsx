/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { sendEmail, shouldSkipEmail } from '@/lib/resend'
import { MagicLinkEmail } from '@/emails/magic-link'

/** Deep link base URL for mobile apps (iOS/Android) */
const deepLinkHost = 'https://app.thunderbolt.io'

/** Platforms that support deep linking */
const deepLinkPlatforms = ['ios', 'android']

/** Tauri app origin - always included for mobile/desktop app support */
const tauriOrigin = 'tauri://localhost'

/** Default trusted origins for development */
const defaultTrustedOrigins = [
  'http://localhost:1420', // Vite dev server
  tauriOrigin, // Tauri app (iOS/Android/Desktop)
]

/**
 * Parse trusted origins from environment variable or use defaults
 * Always includes tauri://localhost for Tauri app support
 */
export const parseTrustedOrigins = (envValue?: string): string[] => {
  const origins = envValue?.split(',').filter(Boolean)
  const baseOrigins = origins && origins.length > 0 ? origins : defaultTrustedOrigins

  // Always ensure tauri://localhost is included for Tauri app support
  if (!baseOrigins.includes(tauriOrigin)) {
    return [...baseOrigins, tauriOrigin]
  }

  return baseOrigins
}

/**
 * Check if the client platform supports deep linking
 */
export const isDeepLinkPlatform = (request?: Request): boolean => {
  const platform = request?.headers.get('x-client-platform')
  return platform ? deepLinkPlatforms.includes(platform) : false
}

/**
 * Validate and extract origin from request
 * Returns the origin if trusted, otherwise falls back to first trusted origin
 */
export const getValidatedOrigin = (trustedOrigins: string[], request?: Request): string => {
  const origin = request?.headers.get('origin')
  if (origin && trustedOrigins.includes(origin)) {
    return origin
  }
  return trustedOrigins[0]
}

/**
 * Build a verify URL that embeds the email and OTP
 * When clicked, the frontend auto-submits the OTP via the standard emailOtp sign-in endpoint
 * Uses deep link URL for mobile platforms so the link opens the app
 */
export const buildVerifyUrl = (
  origin: string,
  email: string,
  otp: string,
  request?: Request,
  challengeToken?: string,
): string => {
  const baseUrl = isDeepLinkPlatform(request) ? deepLinkHost : origin
  const params = new URLSearchParams({ email, otp })
  if (challengeToken) {
    params.set('challengeToken', challengeToken)
  }
  return `${baseUrl}/auth/verify?${params.toString()}`
}

type SendSignInEmailParams = {
  email: string
  otp: string
  verifyUrl: string
}

/** Send sign-in email with both OTP code and a clickable link. */
export const sendSignInEmail = async ({ email, otp, verifyUrl }: SendSignInEmailParams): Promise<void> => {
  if (shouldSkipEmail()) {
    console.info(`🔗 [DEV] Verify URL (no email sent): ${verifyUrl}`)
    console.info(`🔢 [DEV] OTP code: ${otp}`)
    return
  }

  const data = await sendEmail({
    to: email,
    subject: 'Your Thunderbolt verification code',
    react: <MagicLinkEmail code={otp} magicLinkUrl={verifyUrl} />,
  })

  console.info(`✅ Sign-in email sent successfully. ID: ${data?.id}`)
}
