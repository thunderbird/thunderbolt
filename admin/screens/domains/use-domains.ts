/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { OrgDomain } from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { useAdminApi } from '../../api/use-admin-api'
import { useConnections } from '../../api/use-connections'
import { claimableConnections } from './domain-rules'

const listKey = adminQueryKeys.domains.list()

/** The list is ordered by domain, as the backend returns it. */
const byDomain = (a: OrgDomain, b: OrgDomain) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0)

const writeDomain = (queryClient: QueryClient, domain: OrgDomain) =>
  queryClient.setQueryData<OrgDomain[]>(
    listKey,
    (items) => items && [...items.filter((item) => item.id !== domain.id), domain].sort(byDomain),
  )

/** The org's domains. Not paged: an org has few. */
export const useDomains = () => {
  const api = useAdminApi()
  return useQuery({ queryKey: listKey, queryFn: () => api.domains.list() })
}

/** The connections that may claim a domain. */
export const useClaimableConnections = () => useConnections(claimableConnections)

export const useAddDomain = () => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (domain: string) => api.domains.add({ domain }),
    onSuccess: (domain) => writeDomain(queryClient, domain),
  })
}

/**
 * A change to one domain. The response replaces the row in the list; a refusal refetches it, since
 * the refusal usually means this view is stale. A change to a claim also changes the connections'
 * `claimedDomains`.
 */
const useDomainChange = <T>(
  change: (variables: T) => Promise<OrgDomain>,
  { touchesConnections = false }: { touchesConnections?: boolean } = {},
) => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: change,
    onSuccess: async (domain) => {
      writeDomain(queryClient, domain)
      if (touchesConnections) {
        await queryClient.invalidateQueries({ queryKey: adminQueryKeys.connections.all })
      }
    },
    onError: () => queryClient.invalidateQueries({ queryKey: adminQueryKeys.domains.all }),
  })
}

export const useVerifyDomain = (domainId: string) => {
  const api = useAdminApi()
  return useDomainChange<void>(() => api.domains.verify(domainId))
}

export const useSetDomainEnrollment = (domainId: string) => {
  const api = useAdminApi()
  return useDomainChange((enabled: boolean) => api.domains.setEnrollment(domainId, enabled))
}

export const useClaimDomain = (domainId: string) => {
  const api = useAdminApi()
  return useDomainChange((connectionId: string) => api.domains.claim(domainId, connectionId), {
    touchesConnections: true,
  })
}

export const useReleaseDomain = (domainId: string) => {
  const api = useAdminApi()
  return useDomainChange<void>(() => api.domains.unclaim(domainId), { touchesConnections: true })
}

export const useRemoveDomain = () => {
  const api = useAdminApi()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (domainId: string) => api.domains.remove(domainId),
    onSuccess: (_, domainId) =>
      queryClient.setQueryData<OrgDomain[]>(listKey, (items) => items?.filter((item) => item.id !== domainId)),
    // A refusal (claimed meanwhile, already removed) means the row is stale.
    onError: () => queryClient.invalidateQueries({ queryKey: adminQueryKeys.domains.all }),
  })
}
