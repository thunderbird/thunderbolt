/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isTauri, isMobile } from '@/lib/platform'
import { getMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'

export const providerAuthorizationDraftKey = 'thunderbolt-provider-authorization-draft'
/** Mobile redirects must survive the OS terminating the app's webview. */
export const providerAuthorizationDraftStorage = () => (isTauri() && isMobile() ? localStorage : sessionStorage)

/** Keep a validated search authorization return in its onboarding wizard. */
export const isOnboardingSearchAuthorization = (): boolean => {
  try {
    const draft: unknown = JSON.parse(
      providerAuthorizationDraftStorage().getItem(providerAuthorizationDraftKey) ?? 'null',
    )
    return (
      typeof draft === 'object' &&
      draft !== null &&
      'purpose' in draft &&
      draft.purpose === 'onboarding-search' &&
      'provider' in draft &&
      (draft.provider === 'exa' || draft.provider === 'tavily') &&
      getMcpOAuthState().serverId === `oauth:${draft.provider}`
    )
  } catch {
    return false
  }
}
