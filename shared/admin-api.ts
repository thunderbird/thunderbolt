/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Request and response types of the `/v1/admin/*` API, as they travel over the wire: timestamps
 * are ISO 8601 strings. The backend services are checked against these types
 * (`backend/src/identity/admin/api-contract.test.ts`) and the admin screens build on them.
 */

/** An ISO 8601 timestamp, as JSON carries a `Date`. */
export type Timestamp = string

/** The only role an admin can assign. Every member also holds `member`. */
export const adminRole = 'admin'

export type AssignableRole = typeof adminRole

/** The largest page any admin list returns. */
export const adminPageMaxSize = 100

/** One page of a cursor-paged list. Pass `nextCursor` back as `cursor` for the next page; null on the last. */
export type Page<T> = { items: T[]; nextCursor: string | null }

export type PageQuery = { cursor?: string; limit?: number }

/** Every error code an admin route answers with. */
export type AdminErrorCode =
  | 'ADMIN_REQUIRED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CURSOR'
  | 'LINK_REVIEW_INVALID_CURSOR'
  // Members
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_ROLE_NOT_FOUND'
  | 'MEMBER_LINK_NOT_FOUND'
  | 'MEMBER_HAS_ACCESS'
  | 'MEMBER_SUSPENDED_BY_IDP'
  | 'BLOCK_SELF'
  | 'DETACH_SELF'
  | 'PURGE_SELF'
  | 'FIELD_MANAGED_BY_IDP'
  | 'LINK_NOT_DETACHABLE'
  | 'LINK_SOURCE_ACTIVE'
  | 'LINK_SOURCE_SUSPENDED'
  // Roles and groups
  | 'ROLE_INVALID'
  | 'ROLE_MANAGED_BY_IDP'
  | 'ROLE_FROM_LOCAL_GROUP'
  | 'GROUP_NOT_FOUND'
  | 'GROUP_NAME_TAKEN'
  | 'MAPPING_NOT_FOUND'
  | 'MAPPING_EXISTS'
  // Connections
  | 'CONNECTION_NOT_FOUND'
  | 'CONNECTION_NAME_TAKEN'
  | 'SSO_CONNECTION_NOT_FOUND'
  | 'SSO_CONNECTION_ENV_OWNED'
  | 'SSO_CONNECTION_UNAVAILABLE'
  | 'SSO_DISCOVERY_URL_INVALID'
  | 'SSO_DISCOVERY_URL_UNTRUSTED'
  | 'SSO_IDENTITY_FIELD_IMMUTABLE'
  | 'SSO_IDENTITY_FIELD_LOCKED'
  | 'SSO_MATCH_CLAIM_LOCKED'
  | 'SSO_PROTOCOL_MISMATCH'
  | 'SSO_PROVIDER_ID_INVALID'
  | 'SSO_PROVIDER_ID_TAKEN'
  | 'SCIM_CONNECTION_NOT_FOUND'
  | 'SCIM_CONNECTION_UNAVAILABLE'
  | 'SCIM_GROUP_NOT_FOUND'
  | 'SCIM_SIDE_NOT_RETIRED'
  // Admission
  | 'INVALID_DOMAIN'
  | 'DOMAIN_NOT_FOUND'
  | 'DOMAIN_NOT_VERIFIED'
  | 'DOMAIN_CLAIMED_BY_IDP'
  | 'DOMAIN_EXISTS'
  | 'ALREADY_MEMBER'
  | 'INVITATION_NOT_FOUND'
  | 'LINK_REVIEW_NOT_FOUND'
  | 'LINK_REVIEW_RESOLVED'
  | 'LINK_REVIEW_SELF'
  | 'LINK_REVIEW_RECORD_EXISTS'
  // Audit log
  | 'AUDIT_EVENT_NOT_FOUND'

/** An error answer. `field` names the offending field on the SSO lock and immutable-field errors. */
export type AdminErrorBody = { code: string; message?: string; field?: string }

/** Returned by a change that left no admin who can sign in without the IdP. The change stands. */
export type BreakGlassWarning = { warning?: 'NO_LOCAL_ADMIN' }

export type BreakGlassStatus = { allAdminsIdpManaged: boolean; adminCount: number; localAdminCount: number }

// Members

export type AccessRefusal = 'not_member' | 'blocked' | 'deprovisioned' | 'no_live_source' | 'sso_required'

export type AccessDecision = { allowed: true } | { allowed: false; reason: AccessRefusal }

export type MembershipSourceKind =
  | 'scim'
  | 'sso'
  | 'invitation'
  | 'domain'
  | 'waitlist'
  | 'open'
  | 'local'
  | 'bootstrap'

export type MembershipSourceStatus = 'active' | 'suspended' | 'removed'

/** What the IdP owns on a member it manages: an admin can't edit these. */
export type IdpManagedField = 'email' | 'name' | 'scimGroups' | 'scimRoles' | 'status'

export type MemberRoleSource = {
  role: string
  from: 'local' | 'bootstrap' | 'local_group' | 'scim'
  /** The group's id: the key. */
  groupId?: string
  /** The group's name, a display label only: a local group's name or a SCIM group's displayName. */
  groupName?: string
  connectionId?: string
}

export type AdminMember = {
  userId: string
  email: string
  name: string
  joinedAt: Timestamp
  access: AccessDecision
  blocked: { at: Timestamp; by: string | null; reason: string | null } | null
  sources: {
    kind: MembershipSourceKind
    status: MembershipSourceStatus
    connection: { id: string; name: string } | null
  }[]
  /** Every role the member holds and where it comes from. Usable only while `access` allows them in. */
  roles: MemberRoleSource[]
  /** The local groups the member is in, by name. */
  groups: { id: string; name: string }[]
  /** Null when no IdP manages the member. */
  idpManaged: { connections: { id: string; name: string }[]; fields: IdpManagedField[] } | null
  requiresSso: boolean
}

/** A role change that can take admin away also answers with a break-glass warning. */
export type AdminMemberWithWarning = AdminMember & BreakGlassWarning

export type ListMembersQuery = PageQuery & { q?: string }

export type UpdateMemberBody = { name: string }

export type BlockMemberBody = { reason?: string }

export type GrantRoleBody = { role: AssignableRole }

// Groups

export type LocalGroup = {
  id: string
  name: string
  description: string | null
  memberCount: number
  roles: string[]
  createdAt: Timestamp
}

export type LocalGroupMember = { userId: string; email: string; name: string; addedAt: Timestamp }

export type CreateGroupBody = { name: string; description?: string }

export type UpdateGroupBody = { name?: string; description?: string }

export type AddGroupMemberBody = { userId: string }

/** A SCIM group is keyed by its id, never its name: renaming it in the IdP changes no mapping. */
export type RoleMapping = {
  id: string
  role: string
  target:
    | { kind: 'local_group'; groupId: string; name: string }
    | { kind: 'scim_group'; connectionId: string; scimGroupId: string; displayName: string | null }
  createdAt: Timestamp
}

export type RoleMappingQuery = { connectionId?: string; localGroupId?: string }

export type CreateRoleMappingBody =
  | { localGroupId: string; role: AssignableRole }
  | { identityConnectionId: string; scimGroupId: string; role: AssignableRole }

export type ScimGroup = {
  id: string
  displayName: string
  externalId: string | null
  memberCount: number
  roles: string[]
}

// Connections

export type ConnectionStatus = 'active' | 'scim_retiring' | 'scim_retired' | 'retired'

export type SsoProtocol = 'oidc' | 'saml'

export type AdminConnection = {
  id: string
  name: string
  status: ConnectionStatus
  matchClaim: string
  /** Never the client secret or the certificate: only what names the IdP. */
  sso: { providerId: string; protocol: SsoProtocol; issuer: string; envOwned: boolean } | null
  scim: { scimConnectionId: string } | null
  claimedDomains: string[]
  createdAt: Timestamp
}

export type ScimScope = 'scim.users.read' | 'scim.users.write' | 'scim.groups.read' | 'scim.groups.write'

/** A SCIM credential's state. Never its token. */
export type ScimCredential = {
  credentialId: string
  status: 'active' | 'expired' | 'revoked' | 'decommissioned'
  scopes: ScimScope[]
  expiresAt: Timestamp
  createdAt: Timestamp
  createdBy: string
  lastUsedAt: Timestamp | null
  revokedAt: Timestamp | null
  revokedBy: string | null
}

export type OidcSettings = { protocol: 'oidc'; clientId: string; discoveryEndpoint: string | null }

export type SamlSettings = { protocol: 'saml'; entityId: string; entryPoint: string; idpIssuer: string | null }

/** An SSO side's settings an admin may see: never the client secret or the certificate. */
export type SsoSettings = OidcSettings | SamlSettings

/** A field that decides which IdP identity an account belongs to, so it changes only while nothing depends on it. */
export type SsoLockableField = 'clientId' | 'discoveryEndpoint' | 'entryPoint' | 'matchClaim'

export type AdminConnectionDetail = Omit<AdminConnection, 'sso'> & {
  sso: (NonNullable<AdminConnection['sso']> & SsoSettings) | null
  /**
   * What an edit would refuse to change right now: the identity fields while an identity is linked,
   * and the match claim while one is linked or a link review is open.
   */
  lockedFields: SsoLockableField[]
  scimCredentials: ScimCredential[]
}

export type OidcConfig = { issuer: string; clientId: string; clientSecret: string; discoveryEndpoint?: string }

export type SamlConfig = { entityId: string; entryPoint: string; cert: string; idpIssuer: string }

export type CreateSsoConnectionBody = {
  name: string
  providerId: string
  protocol: { oidc: OidcConfig } | { saml: SamlConfig }
  matchClaim?: string
  /** Adds the SSO side to this existing (SCIM) connection. */
  identityConnectionId?: string
}

export type UpdateSsoConnectionBody = {
  name?: string
  matchClaim?: string
  providerId?: string
  oidc?: Partial<OidcConfig>
  saml?: Partial<SamlConfig>
}

/** A new SCIM-only connection, or a SCIM side on an existing (SSO) connection. */
export type CreateScimConnectionBody =
  | { name: string; expiresAt?: Timestamp }
  | { identityConnectionId: string; expiresAt?: Timestamp }

/** The connection row as SCIM creation returns it. */
export type IdentityConnectionRecord = {
  id: string
  orgId: string
  name: string
  ssoProviderId: string | null
  scimConnectionId: string | null
  status: ConnectionStatus
  retireRequestedAt: Timestamp | null
  retiredAt: Timestamp | null
  retiredBy: string | null
  createdBy: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** `token` is shown once, here, and never again. */
export type CreateScimConnectionResponse = {
  connection: IdentityConnectionRecord
  credential: ScimCredential
  token: string
}

export type RotateScimCredentialBody = { expiresAt?: Timestamp }

/** `token` is shown once, here, and never again. */
export type RotateScimCredentialResponse = { credential: ScimCredential; token: string }

/** The SCIM base URL, relative to the API base (`…/v1`). */
export const scimBasePath = '/api/auth/scim/v2'

// Invitations and domains

export type InvitationStatus = 'pending' | 'accepted' | 'revoked'

export type Invitation = {
  id: string
  email: string
  status: InvitationStatus
  expiresAt: Timestamp
  idpOverride: boolean
  invitedBy: string | null
  createdAt: Timestamp
}

/** `expired` keeps only the invitations past (`true`) or before (`false`) their expiry. */
export type ListInvitationsQuery = PageQuery & { status?: InvitationStatus; q?: string; expired?: boolean }

export type CreateInvitationBody = { email: string; idpOverride?: boolean }

/** Why the last verification check failed. */
export type DomainCheckError = 'TXT_RECORD_NOT_FOUND' | 'TXT_RECORD_MISMATCH' | 'DNS_LOOKUP_FAILED'

export type OrgDomain = {
  id: string
  domain: string
  verifiedAt: Timestamp | null
  lastCheckedAt: Timestamp | null
  lastCheckError: DomainCheckError | null
  enrollmentEnabled: boolean
  claimedBy: { id: string; name: string } | null
  /** The TXT record that verifies the domain. */
  record: { name: string; value: string }
  createdAt: Timestamp
}

export type AddDomainBody = { domain: string }

export type SetEnrollmentBody = { enabled: boolean }

export type ClaimDomainBody = { identityConnectionId: string }

// Link reviews

export type LinkReviewStatus = 'pending' | 'approved' | 'rejected' | 'linked'

export type LinkReviewRecord = {
  id: string
  orgId: string
  identityConnectionId: string
  trigger: 'scim_create_conflict' | 'sso_sign_in'
  externalId: string
  incomingEmail: string
  incomingName: string | null
  candidateUserId: string
  status: LinkReviewStatus
  resolvedBy: string | null
  resolvedAt: Timestamp | null
  attempts: number
  lastSeenAt: Timestamp
  createdAt: Timestamp
  updatedAt: Timestamp
}

/** A review with both identities: the arriving one and the existing account it would link to. */
export type LinkReview = LinkReviewRecord & {
  candidate: { id: string; email: string; name: string }
  connection: { id: string; name: string }
}

/** The wire shape of `GET /admin/link-reviews`; the admin client returns it as a `Page`. */
export type LinkReviewPage = { reviews: LinkReview[]; nextCursor: string | null }

/** `q` matches part of the incoming email or name, or the candidate account's. */
export type ListLinkReviewsQuery = PageQuery & { status?: LinkReviewStatus; connectionId?: string; q?: string }

// Audit

/**
 * Every audit action the backend records. The outcome (`success`, `failure`, `denied`) is its own
 * column, so an action has no failed variant. Adding an action is a code change, not a migration.
 */
export const auditActions = [
  // Authentication and sessions
  'auth.sign_in',
  'auth.sign_out',
  'auth.session_revoked',
  'auth.session_expired',
  'account.deleted',
  // Members
  'member.admitted',
  'member.source_added',
  'member.source_suspended',
  'member.source_removed',
  'member.blocked',
  'member.unblocked',
  'member.updated',
  'member.role_granted',
  'member.role_revoked',
  'member.bootstrap_admin_granted',
  'member.purged',
  // Linking
  'link.created',
  'link.detached',
  'link_review.created',
  'link_review.approved',
  'link_review.rejected',
  // Invitations and domains
  'invitation.created',
  'invitation.accepted',
  'invitation.revoked',
  'invitation.override_used',
  'domain.added',
  'domain.verified',
  'domain.removed',
  'domain.claimed',
  'domain.unclaimed',
  // Groups and role mappings
  'local_group.created',
  'local_group.updated',
  'local_group.deleted',
  'local_group.member_added',
  'local_group.member_removed',
  'group_role_mapping.created',
  'group_role_mapping.deleted',
  // Connections and configuration
  'connection.created',
  'connection.updated',
  'connection.retiring',
  'connection.retired',
  'scim_credential.issued',
  'scim_credential.rotated',
  'scim_credential.revoked',
  'admission_policy.updated',
  // Provisioning, attributed to the SCIM connection
  'scim.user_created',
  'scim.user_updated',
  'scim.user_deactivated',
  'scim.user_reactivated',
  'scim.user_deleted',
  'scim.group_created',
  'scim.group_updated',
  'scim.group_deleted',
  'scim.group_members_changed',
  'scim.request',
  // A user's own connections; changes that happen only on the device are client-reported
  'user_connection.added',
  'user_connection.updated',
  'user_connection.removed',
  'user_connection.credential_replaced',
  // Audit administration
  'audit.read_bulk',
  'audit.exported',
  'admin.access_denied',
] as const

export type AuditAction = (typeof auditActions)[number]

export type AuditOutcome = 'success' | 'failure' | 'denied'

export type AuditActorType = 'user' | 'scim_connection' | 'system'

export type AuditEvent = {
  id: string
  orgId: string
  occurredAt: Timestamp
  action: string
  outcome: AuditOutcome
  reason: string | null
  actorType: AuditActorType
  actorId: string | null
  targetType: string | null
  targetId: string | null
  connectionId: string | null
  credentialId: string | null
  requestId: string | null
  reportSource: 'server' | 'client'
  changes: unknown
  metadata: unknown
  /** Sign-in events only. */
  ipAddress: string | null
  userAgent: string | null
  /** The actor's name (a person's name or email, or a connection's name), or null when none is known. */
  actorLabel: string | null
  /** The target's name (a person, connection, group, domain or invitation), or null when none is known. */
  targetLabel: string | null
  /** The name of the API key the actor acted through (`metadata.apiKeyId`), or null when none, or it's gone. */
  apiKeyLabel: string | null
}

/** The wire shape of `GET /admin/audit-events`; the admin client returns it as a `Page`. */
export type AuditEventPage = { events: AuditEvent[]; nextCursor: string | null }

export type AuditEventQuery = PageQuery & {
  action?: string
  outcome?: AuditOutcome
  actorId?: string
  targetType?: string
  targetId?: string
  connectionId?: string
  from?: Timestamp
  to?: Timestamp
  /**
   * Part of the actor's or target's name, or of the API key the actor acted through: a person's name or email, a
   * connection, group, domain or API key.
   */
  q?: string
}
