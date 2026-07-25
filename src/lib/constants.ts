/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * App-wide constants
 */

/** URL to Mozilla/Thunderbird privacy policy */
export const privacyPolicyUrl = 'https://www.thunderbird.net/en-US/privacy/'

/** URL to Mozilla terms of service */
export const termsOfServiceUrl = 'https://www.mozilla.org/en-US/about/legal/terms/mozilla/'

/** Default title shown for new/untitled chat threads */
export const defaultChatTitle = 'New Chat'

/** Standardized spacing between viewport/container edge and content (in px) */
export const edgeSpacing = {
  mobile: 12,
  desktop: 16,
} as const

/**
 * CSS `bottom`/inset expression for controls floating at the bottom edge of
 * the mobile viewport (sidebar footer, floating create pill). Native mobile
 * pins to the home-indicator safe area with an `edgeSpacing.mobile` (12px)
 * floor; web mobile adds 8px of breathing room above the safe area.
 */
export const getMobileBottomInset = (isNativeMobile: boolean): string =>
  isNativeMobile
    ? `max(var(--safe-area-bottom-padding), ${edgeSpacing.mobile}px)`
    : 'calc(var(--safe-area-bottom-padding, 0px) + 0.5rem)'

/** Mobile sidebar width as a fraction of viewport width (0–1) */
const mobileSidebarWidthRatio = 0.8

/** Maximum mobile sidebar width in pixels. Matches the 360px desktop content
 *  floor in main-layout.tsx so the sidebar never outgrows a usable pane. */
const mobileSidebarMaxWidth = 360

/** Mobile sidebar width shared by CSS sizing and overlays rendered in portals. */
export const mobileSidebarWidthCss = `min(${mobileSidebarWidthRatio * 100}vw, ${mobileSidebarMaxWidth}px)`

/** Calculates the mobile sidebar width for gestures and hit testing. */
export const getMobileSidebarWidth = (viewportWidth: number) =>
  Math.min(viewportWidth * mobileSidebarWidthRatio, mobileSidebarMaxWidth)

/** OTP code length — must match backend emailOTP config (otpLength). */
export const otpLength = 8

/** HTTP header name for challenge token session binding. */
export const challengeTokenHeader = 'x-challenge-token'
