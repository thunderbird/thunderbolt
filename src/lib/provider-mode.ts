/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getLocalSetting, isCurrentServer } from '@/stores/local-settings-store'
import { getAuthToken } from '@/lib/auth-token'
import { getCachedSession, isCachedSessionValid } from '@/lib/session-cache'

/** Browser SSO can authenticate with a session cookie without issuing a bearer token. */
export const hasServerAuthentication = (): boolean => {
  if (!isCurrentServer(getLocalSetting('cloudUrl'))) {
    return false
  }
  if (getAuthToken()) {
    return true
  }
  const session = getCachedSession()
  return Boolean(session?.user?.id && isCachedSessionValid(session))
}

/** Local users keep their own providers until they authenticate to the chosen server. */
export const usesLocalProviders = (
  cloudUrl = getLocalSetting('cloudUrl'),
  localMode = getLocalSetting('localMode'),
  authenticated = hasServerAuthentication(),
): boolean => !cloudUrl || (localMode && !authenticated)
