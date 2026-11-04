/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toCompilableQuery } from '@powersync/drizzle-driver'
import { useQuery } from '@powersync/tanstack-react-query'
import { useDatabase } from '@/contexts'
import { getAllMcpServers } from '@/dal'
import type { CloudConnectionView } from './client'
import { getCloudMcpBinding } from './connection-library'

/** Agent controls consume the same MCP library as Connections, with cloud authorization resolved separately. */
export const useCloudMcpLibrary = (connections: CloudConnectionView[]) => {
  const db = useDatabase()
  const query = useQuery({ queryKey: ['mcp-library'], query: toCompilableQuery(getAllMcpServers(db)) })
  const servers = query.data ?? []
  return {
    servers,
    entries: servers.map((server) => getCloudMcpBinding(server, connections)),
    isPending: query.isPending,
    error: query.error,
  }
}
