/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useDatabase } from '@/contexts'
import { getRemoteMcpServers } from '@/dal'
import { useMCP } from '@/lib/mcp-provider'
import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useEffect, useEffectEvent } from 'react'

export const useMcpSync = () => {
  const db = useDatabase()
  const { servers, addServer, removeServer, updateServer } = useMCP()

  const { data: dbServers = [] } = useQuery({
    queryKey: ['mcp-servers'],
    query: toCompilableQuery(getRemoteMcpServers(db)),
  })

  // Reconcile the provider from the DB snapshot: add missing rows, remove rows
  // the DB no longer has, and patch rows whose name/url/type/enabled diverged.
  // Wrapped in `useEffectEvent` so the effect below depends only on `dbServers`
  // — otherwise the provider callbacks (which are re-created every render) and
  // `servers` (which changes as reconcile itself commits) would re-fire the
  // effect on every provider render and race against the async `updateServer`
  // it just kicked off.
  const reconcile = useEffectEvent(async () => {
    const providerServerIds = new Set(servers.map((s) => s.id))

    for (const dbServer of dbServers) {
      if (!providerServerIds.has(dbServer.id)) {
        await addServer({
          id: dbServer.id,
          name: dbServer.name ?? '',
          url: dbServer.url ?? '',
          type: dbServer.type === 'sse' ? 'sse' : 'http',
          enabled: dbServer.enabled === 1,
        })
      }
    }

    const dbServerIds = new Set(dbServers.map((s) => s.id))
    for (const providerServer of servers) {
      if (!dbServerIds.has(providerServer.id)) {
        removeServer(providerServer.id)
      }
    }

    // `updateServer` redials when enabled so a URL or transport change actually
    // takes effect (the previous sync only handled enable toggles, leaving
    // editors connected to the old endpoint).
    for (const dbServer of dbServers) {
      const providerServer = servers.find((s) => s.id === dbServer.id)
      if (!providerServer) {
        continue
      }
      const next = {
        id: dbServer.id,
        name: dbServer.name ?? '',
        url: dbServer.url ?? '',
        type: dbServer.type === 'sse' ? ('sse' as const) : ('http' as const),
        enabled: dbServer.enabled === 1,
      }
      if (
        providerServer.name !== next.name ||
        providerServer.url !== next.url ||
        providerServer.type !== next.type ||
        providerServer.enabled !== next.enabled
      ) {
        updateServer(next)
      }
    }
  })

  useEffect(() => {
    reconcile()
    // Effect Events don't get listed in deps; only DB changes trigger a reconcile.
  }, [dbServers])

  return { servers, dbServers }
}
