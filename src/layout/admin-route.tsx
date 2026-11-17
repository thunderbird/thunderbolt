/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useAuth } from '@/contexts'
import { useIsAdmin } from '@/hooks/use-is-admin'
import { PageFallback } from '@/loading'
import { Navigate, Outlet } from 'react-router'

/** Renders the admin routes for admins and sends everyone else to the chat home. Cosmetic: the API rechecks. */
export const AdminRoute = () => {
  const session = useAuth().useSession()
  const isAdmin = useIsAdmin()
  if (session.isPending && !session.data) {
    return <PageFallback />
  }
  return isAdmin ? <Outlet /> : <Navigate to="/chats/new" replace />
}
