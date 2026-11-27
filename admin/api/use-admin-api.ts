/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useAuth } from '@/contexts'
import { useHttpClient } from '@/contexts/http-client-context'
import { useMemo } from 'react'
import { createAdminApi, type AdminApi } from './client'

/**
 * The admin API on the app's authenticated HTTP client. A 403 `ADMIN_REQUIRED` reads the session
 * again, so a demoted admin loses the admin UI at once instead of on the next session read.
 */
export const useAdminApi = (): AdminApi => {
  const http = useHttpClient()
  const { refetch } = useAuth().useSession()
  return useMemo(() => createAdminApi(http, { onAdminRequired: () => void refetch() }), [http, refetch])
}
