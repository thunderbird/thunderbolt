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

/** Mobile sidebar width as a fraction of viewport width (0–1) */
export const mobileSidebarWidthRatio = 0.8
