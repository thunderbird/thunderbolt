/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearDebugTranscriptRecorder } from '@/debug-transcript/recorder'
import { invalidateIdentityLifetime } from '@/lib/identity-lifetime'
import { cancelOtariBrowserConnection } from '@/lib/otari-browser-auth'
import { cancelProviderBrowserConnection } from '@/lib/provider-browser-auth'
import { cancelTinfoilMobileConnection } from '@/lib/tinfoil-mobile-auth'
import { clearAllOAuthConnectingState, clearOAuthState } from '@/lib/oauth-state'
import { clearMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { clearProviderAuthorizationDraft } from '@/providers/authorization-draft'

/** Clear session memory that must never survive an identity transition. */
export const clearIdentityScopedMemory = (): void => {
  invalidateIdentityLifetime()
  cancelOtariBrowserConnection()
  cancelProviderBrowserConnection()
  cancelTinfoilMobileConnection()
  for (const clear of [
    clearOAuthState,
    clearAllOAuthConnectingState,
    clearMcpOAuthState,
    clearProviderAuthorizationDraft,
  ]) {
    try {
      clear()
    } catch {
      // Storage can become unavailable during sign-out; every other teardown step must still run.
    }
  }
  clearDebugTranscriptRecorder()
}
