/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { eq, sql } from 'drizzle-orm'
import { useDatabase } from '@/contexts'
import { integrationsSecretsTable } from '@/db/tables'

/** Watches connection changes from token refresh and other windows without caching credentials in UI state. */
export const useTinfoilConnection = () => {
  const db = useDatabase()
  const query = useQuery({
    queryKey: ['tinfoil-connection'],
    query: toCompilableQuery(
      db
        .select({
          enabled: sql<boolean>`${integrationsSecretsTable.enabled} = 1`.mapWith(Boolean),
          connected: sql<boolean>`CASE WHEN json_valid(${integrationsSecretsTable.credentials})
            THEN COALESCE(json_extract(${integrationsSecretsTable.credentials}, '$.access_token'), '') != ''
            ELSE 0 END`.mapWith(Boolean),
          needsReauth: sql<boolean>`CASE WHEN json_valid(${integrationsSecretsTable.credentials})
            THEN COALESCE(json_extract(${integrationsSecretsTable.credentials}, '$.reauth_required'), 0) != 0
            ELSE 0 END`.mapWith(Boolean),
        })
        .from(integrationsSecretsTable)
        .where(eq(integrationsSecretsTable.provider, 'tinfoil')),
    ),
  })
  return {
    data: query.data?.[0],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isSuccess: query.isSuccess,
  }
}
