/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { agentRegistrySnapshot } from '@/defaults/agent-registry'
import { parseRegistryJson } from '@/lib/agent-registry-filter'
import type { FetchFn } from '@/lib/proxy-fetch'
import { useFetch } from '@/lib/proxy-fetch-context'
import type { RegistryEntry } from '@/types/registry'
import { useQuery } from '@tanstack/react-query'

/** The official, machine-readable ACP registry. */
export const acpRegistryUrl = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

const staleTime = 5 * 60 * 1000 // 5 minutes

/**
 * Fetches the live registry through the universal proxy. The CDN sends no
 * `access-control-allow-origin`, so a direct browser fetch is CORS-blocked —
 * the proxy fetch (Hosted: `/v1/proxy`; Standalone: upstream-direct) is the
 * only way a browser can read it. A degenerate (empty) live response falls back
 * to the snapshot so a bad CDN payload can never blank the catalogue.
 */
const fetchAgentRegistry = (proxyFetch: FetchFn) => async (): Promise<ReadonlyArray<RegistryEntry>> => {
  const response = await proxyFetch(acpRegistryUrl)
  const parsed = parseRegistryJson(await response.json())
  return parsed.length > 0 ? parsed : agentRegistrySnapshot
}

/**
 * Returns the ACP agent catalogue. The bundled snapshot is the immediate seed
 * (`initialData`), so the array is always non-empty and the UI renders instantly
 * even offline. React Query refreshes from the live CDN through the universal
 * proxy in the background; on any fetch/parse error it keeps the last good data,
 * which falls back to the snapshot. Anonymous / offline / proxy-unavailable users
 * therefore always see the snapshot.
 */
export const useAgentRegistry = (): ReadonlyArray<RegistryEntry> => {
  const proxyFetch = useFetch()
  const { data } = useQuery({
    queryKey: ['acp-agent-registry'],
    queryFn: fetchAgentRegistry(proxyFetch),
    initialData: agentRegistrySnapshot,
    staleTime,
  })
  return data
}
