/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AdminConnectionDetail,
  CreateScimConnectionBody,
  CreateSsoConnectionBody,
  UpdateSsoConnectionBody,
} from '@shared/admin-api'
import { adminQueryKeys } from '../../api/query-keys'
import { secretMutationOptions } from '../../api/secret-mutation'
import { useAdminApi } from '../../api/use-admin-api'
import { useCursorList } from '../../api/use-cursor-list'

/** How often a connection whose SCIM side is retiring is read again, until the background job ends. */
export const retiringPollMs = 2000

export const useConnection = (connectionId: string) => {
  const api = useAdminApi()
  return useQuery({
    queryKey: adminQueryKeys.connections.detail(connectionId),
    queryFn: () => api.connections.get(connectionId),
    refetchInterval: (query) => (query.state.data?.status === 'scim_retiring' ? retiringPollMs : false),
  })
}

export const useScimGroups = (connectionId: string) => {
  const api = useAdminApi()
  return useCursorList({
    queryKey: adminQueryKeys.connections.scimGroups(connectionId),
    fetchPage: (cursor) => api.connections.listScimGroups(connectionId, { cursor }),
  })
}

/**
 * Refresh every connection read, and the members too when access may have changed (retiring a
 * side stops counting the sources it admitted).
 */
const useInvalidateConnections = () => {
  const queryClient = useQueryClient()
  return ({ members = false }: { members?: boolean } = {}) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: adminQueryKeys.connections.all }),
      members && queryClient.invalidateQueries({ queryKey: adminQueryKeys.members.all }),
    ])
}

/** Store a returned detail, so the panel shows it without another read. */
const useStoreDetail = () => {
  const queryClient = useQueryClient()
  return (detail: AdminConnectionDetail) =>
    queryClient.setQueryData(adminQueryKeys.connections.detail(detail.id), detail)
}

export const useCreateSsoConnection = () => {
  const api = useAdminApi()
  const invalidate = useInvalidateConnections()
  const store = useStoreDetail()
  return useMutation({
    mutationFn: (body: CreateSsoConnectionBody) => api.connections.createSso(body),
    onSuccess: async (detail) => {
      store(detail)
      await invalidate()
    },
  })
}

export const useUpdateSsoConnection = (connectionId: string) => {
  const api = useAdminApi()
  const invalidate = useInvalidateConnections()
  const store = useStoreDetail()
  return useMutation({
    mutationFn: (body: UpdateSsoConnectionBody) => api.connections.update(connectionId, body),
    onSuccess: async (detail) => {
      store(detail)
      await invalidate()
    },
  })
}

export const useRetireConnection = () => {
  const api = useAdminApi()
  const invalidate = useInvalidateConnections()
  return useMutation({
    mutationFn: (connectionId: string) => api.connections.retire(connectionId),
    onSuccess: () => invalidate({ members: true }),
  })
}

/** Holds a token in its result: show it with `CopyOnceSecret` and `reset()` the mutation on Done. */
export const useCreateScimConnection = () => {
  const api = useAdminApi()
  const invalidate = useInvalidateConnections()
  return useMutation({
    mutationFn: (body: CreateScimConnectionBody) => api.connections.createScim(body),
    onSuccess: () => invalidate(),
    ...secretMutationOptions,
  })
}

/** Holds a token in its result: show it with `CopyOnceSecret` and `reset()` the mutation on Done. */
export const useRotateScimCredential = (connectionId: string) => {
  const api = useAdminApi()
  const invalidate = useInvalidateConnections()
  return useMutation({
    mutationFn: (expiresAt?: string) => api.connections.rotateScimCredential(connectionId, { expiresAt }),
    onSuccess: () => invalidate(),
    ...secretMutationOptions,
  })
}

export const useRevokeScimCredential = (connectionId: string) => {
  const api = useAdminApi()
  const invalidate = useInvalidateConnections()
  return useMutation({
    mutationFn: (credentialId: string) => api.connections.revokeScimCredential(connectionId, credentialId),
    onSuccess: () => invalidate(),
  })
}

export const useRetireScim = (connectionId: string) => {
  const api = useAdminApi()
  const invalidate = useInvalidateConnections()
  return useMutation({
    mutationFn: () => api.connections.retireScim(connectionId),
    onSuccess: () => invalidate({ members: true }),
  })
}
