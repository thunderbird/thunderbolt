/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth } from '@/contexts'
import { adminRole } from '@shared/admin-api'

/**
 * Whether the signed-in user holds the org admin role, read from the session. Only hides or shows
 * admin UI: every admin route rechecks on the server.
 */
export const useIsAdmin = (): boolean => useAuth().useSession().data?.user.roles?.includes(adminRole) ?? false
