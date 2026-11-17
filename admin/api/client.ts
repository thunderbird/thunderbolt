/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { HttpError, type HttpClient, type ResponsePromise } from '@/lib/http'
import type {
  AddDomainBody,
  AdminConnection,
  AdminConnectionDetail,
  AdminErrorBody,
  AdminErrorCode,
  AdminMember,
  AdminMemberWithWarning,
  AssignableRole,
  AuditEvent,
  AuditEventPage,
  AuditEventQuery,
  BlockMemberBody,
  BreakGlassStatus,
  BreakGlassWarning,
  CreateGroupBody,
  CreateInvitationBody,
  CreateRoleMappingBody,
  CreateScimConnectionBody,
  CreateScimConnectionResponse,
  CreateSsoConnectionBody,
  Invitation,
  LinkReview,
  LinkReviewPage,
  LinkReviewRecord,
  ListInvitationsQuery,
  ListLinkReviewsQuery,
  ListMembersQuery,
  LocalGroup,
  LocalGroupMember,
  OrgDomain,
  Page,
  PageQuery,
  RoleMapping,
  RoleMappingQuery,
  RotateScimCredentialBody,
  RotateScimCredentialResponse,
  ScimGroup,
  UpdateGroupBody,
  UpdateMemberBody,
  UpdateSsoConnectionBody,
} from '@shared/admin-api'

/** A refused admin request, with the API's error code and, on the SSO field errors, the field. */
export class AdminApiError extends Error {
  readonly field?: string

  constructor(
    readonly status: number,
    readonly code: AdminErrorCode | (string & {}),
    readonly body: Partial<AdminErrorBody> & Record<string, unknown>,
  ) {
    super(`Admin request failed: ${status} ${code}`)
    this.name = 'AdminApiError'
    this.field = typeof body.field === 'string' ? body.field : undefined
  }
}

/** Turn an `HttpError` into an `AdminApiError` carrying the response's code; anything else is rethrown as is. */
export const toAdminApiError = async (error: unknown): Promise<unknown> => {
  if (!(error instanceof HttpError)) {
    return error
  }
  const body = (await error.response.json().catch(() => ({}))) as Record<string, unknown>
  const code = typeof body.code === 'string' ? body.code : String(error.response.status)
  return new AdminApiError(error.response.status, code, body)
}

const segment = encodeURIComponent

type AdminApiOptions = {
  /** Called when the server says the caller is no longer an admin, so the session can be read again. */
  onAdminRequired?: () => void
}

/**
 * Typed calls for every `/v1/admin/*` route, on the app's HTTP client (whose base is `…/v1`).
 * Audit events and link reviews come back as a `Page` like every other list.
 */
export const createAdminApi = (http: HttpClient, { onAdminRequired }: AdminApiOptions = {}) => {
  /** Rethrow `error` as an `AdminApiError`, first telling the app when the caller has lost the admin role. */
  const fail = async (error: unknown): Promise<never> => {
    const mapped = await toAdminApiError(error)
    if (mapped instanceof AdminApiError && mapped.code === 'ADMIN_REQUIRED') {
      onAdminRequired?.()
    }
    throw mapped
  }

  /** The response body as `T`; a failed request throws through `fail`. */
  const read = async <T>(request: ResponsePromise): Promise<T> => {
    try {
      return await request.json<T>()
    } catch (error) {
      return fail(error)
    }
  }

  /** For routes that answer 204 or 202 with nothing the caller needs. */
  const send = async (request: ResponsePromise): Promise<void> => {
    try {
      await request
    } catch (error) {
      await fail(error)
    }
  }

  /** Only the paging fields of `query`, as search params for a list route. */
  const page = (query: PageQuery = {}) => ({ cursor: query.cursor, limit: query.limit })

  return {
    members: {
      list: (query: ListMembersQuery = {}) =>
        // The API refuses an empty `q`: a cleared search lists everyone.
        read<Page<AdminMember>>(
          http.get('admin/members', { searchParams: { ...page(query), q: query.q || undefined } }),
        ),
      get: (userId: string) => read<AdminMember>(http.get(`admin/members/${segment(userId)}`)),
      update: (userId: string, body: UpdateMemberBody) =>
        read<AdminMember>(http.patch(`admin/members/${segment(userId)}`, { json: body })),
      block: (userId: string, body: BlockMemberBody = {}) =>
        read<AdminMemberWithWarning>(http.post(`admin/members/${segment(userId)}/block`, { json: body })),
      unblock: (userId: string) => read<AdminMember>(http.post(`admin/members/${segment(userId)}/unblock`)),
      grantRole: (userId: string, role: AssignableRole) =>
        read<AdminMember>(http.post(`admin/members/${segment(userId)}/roles`, { json: { role } })),
      revokeRole: (userId: string, role: AssignableRole) =>
        read<AdminMemberWithWarning>(http.delete(`admin/members/${segment(userId)}/roles/${segment(role)}`)),
      detachLink: (userId: string, connectionId: string) =>
        read<AdminMember>(http.post(`admin/members/${segment(userId)}/connections/${segment(connectionId)}/detach`)),
      purge: (userId: string) => send(http.delete(`admin/members/${segment(userId)}`)),
    },
    breakGlass: {
      get: () => read<BreakGlassStatus>(http.get('admin/break-glass')),
    },
    groups: {
      list: (query: PageQuery = {}) => read<Page<LocalGroup>>(http.get('admin/groups', { searchParams: page(query) })),
      create: (body: CreateGroupBody) => read<LocalGroup>(http.post('admin/groups', { json: body })),
      get: (groupId: string) => read<LocalGroup>(http.get(`admin/groups/${segment(groupId)}`)),
      update: (groupId: string, body: UpdateGroupBody) =>
        read<LocalGroup>(http.patch(`admin/groups/${segment(groupId)}`, { json: body })),
      remove: (groupId: string) => read<BreakGlassWarning>(http.delete(`admin/groups/${segment(groupId)}`)),
      listMembers: (groupId: string, query: PageQuery = {}) =>
        read<Page<LocalGroupMember>>(
          http.get(`admin/groups/${segment(groupId)}/members`, { searchParams: page(query) }),
        ),
      addMember: (groupId: string, userId: string) =>
        send(http.post(`admin/groups/${segment(groupId)}/members`, { json: { userId } })),
      removeMember: (groupId: string, userId: string) =>
        read<BreakGlassWarning>(http.delete(`admin/groups/${segment(groupId)}/members/${segment(userId)}`)),
    },
    roleMappings: {
      list: async (query: RoleMappingQuery = {}) =>
        (await read<{ items: RoleMapping[] }>(http.get('admin/role-mappings', { searchParams: query }))).items,
      create: (body: CreateRoleMappingBody) =>
        read<RoleMapping & BreakGlassWarning>(http.post('admin/role-mappings', { json: body })),
      remove: (mappingId: string) => read<BreakGlassWarning>(http.delete(`admin/role-mappings/${segment(mappingId)}`)),
    },
    connections: {
      list: async () => (await read<{ items: AdminConnection[] }>(http.get('admin/connections'))).items,
      get: (connectionId: string) =>
        read<AdminConnectionDetail>(http.get(`admin/connections/${segment(connectionId)}`)),
      createSso: (body: CreateSsoConnectionBody) =>
        read<AdminConnectionDetail>(http.post('admin/connections/sso', { json: body })),
      update: (connectionId: string, body: UpdateSsoConnectionBody) =>
        read<AdminConnectionDetail>(http.patch(`admin/connections/${segment(connectionId)}`, { json: body })),
      retire: (connectionId: string) =>
        read<AdminConnectionDetail>(http.post(`admin/connections/${segment(connectionId)}/retire`)),
      listScimGroups: (connectionId: string, query: PageQuery = {}) =>
        read<Page<ScimGroup>>(
          http.get(`admin/connections/${segment(connectionId)}/scim-groups`, { searchParams: page(query) }),
        ),
      createScim: (body: CreateScimConnectionBody) =>
        read<CreateScimConnectionResponse>(http.post('admin/connections/scim', { json: body })),
      rotateScimCredential: (connectionId: string, body: RotateScimCredentialBody = {}) =>
        read<RotateScimCredentialResponse>(
          http.post(`admin/connections/${segment(connectionId)}/scim/credentials`, { json: body }),
        ),
      revokeScimCredential: (connectionId: string, credentialId: string) =>
        send(http.post(`admin/connections/${segment(connectionId)}/scim/credentials/${segment(credentialId)}/revoke`)),
      retireScim: (connectionId: string) =>
        read<AdminConnectionDetail>(http.post(`admin/connections/${segment(connectionId)}/scim/retire`)),
    },
    invitations: {
      list: (query: ListInvitationsQuery = {}) =>
        read<Page<Invitation>>(
          http.get('admin/invitations', { searchParams: { ...page(query), status: query.status } }),
        ),
      create: (body: CreateInvitationBody) => read<Invitation>(http.post('admin/invitations', { json: body })),
      revoke: (invitationId: string) => send(http.post(`admin/invitations/${segment(invitationId)}/revoke`)),
    },
    domains: {
      list: async () => (await read<{ items: OrgDomain[] }>(http.get('admin/domains'))).items,
      add: (body: AddDomainBody) => read<OrgDomain>(http.post('admin/domains', { json: body })),
      verify: (domainId: string) => read<OrgDomain>(http.post(`admin/domains/${segment(domainId)}/verify`)),
      setEnrollment: (domainId: string, enabled: boolean) =>
        read<OrgDomain>(http.put(`admin/domains/${segment(domainId)}/enrollment`, { json: { enabled } })),
      claim: (domainId: string, identityConnectionId: string) =>
        read<OrgDomain>(http.put(`admin/domains/${segment(domainId)}/claim`, { json: { identityConnectionId } })),
      unclaim: (domainId: string) => read<OrgDomain>(http.delete(`admin/domains/${segment(domainId)}/claim`)),
      remove: (domainId: string) => send(http.delete(`admin/domains/${segment(domainId)}`)),
    },
    linkReviews: {
      list: async (query: ListLinkReviewsQuery = {}): Promise<Page<LinkReview>> => {
        const { reviews, nextCursor } = await read<LinkReviewPage>(
          http.get('admin/link-reviews', {
            searchParams: { ...page(query), status: query.status, connectionId: query.connectionId },
          }),
        )
        return { items: reviews, nextCursor }
      },
      approve: (reviewId: string) =>
        read<LinkReviewRecord>(http.post(`admin/link-reviews/${segment(reviewId)}/approve`)),
      reject: (reviewId: string) => read<LinkReviewRecord>(http.post(`admin/link-reviews/${segment(reviewId)}/reject`)),
    },
    auditEvents: {
      list: async (query: AuditEventQuery = {}): Promise<Page<AuditEvent>> => {
        const { events, nextCursor } = await read<AuditEventPage>(
          http.get('admin/audit-events', { searchParams: query }),
        )
        return { items: events, nextCursor }
      },
    },
  }
}

export type AdminApi = ReturnType<typeof createAdminApi>
