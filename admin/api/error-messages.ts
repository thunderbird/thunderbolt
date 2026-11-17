/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { isFetchNetworkError } from '@/lib/http'
import type { AdminErrorCode, DomainCheckError } from '@shared/admin-api'
import { AdminApiError } from './client'

/** The message for each admin error code. Descriptors: resolve them with `i18n._()` where they're shown. */
export const adminErrorMessages: Record<AdminErrorCode, MessageDescriptor> = {
  ADMIN_REQUIRED: msg`You're no longer an admin of this organization.`,
  UNAUTHENTICATED: msg`Your session has ended. Sign in again.`,
  INVALID_CURSOR: msg`This list changed. Reload it and try again.`,
  LINK_REVIEW_INVALID_CURSOR: msg`This list changed. Reload it and try again.`,
  MEMBER_NOT_FOUND: msg`This member no longer exists.`,
  MEMBER_ROLE_NOT_FOUND: msg`This member doesn't hold that role.`,
  MEMBER_LINK_NOT_FOUND: msg`This member isn't linked to that identity provider.`,
  MEMBER_HAS_ACCESS: msg`Only a removed member can be deleted. Remove their access first.`,
  MEMBER_SUSPENDED_BY_IDP: msg`The identity provider has suspended this member. Remove them there first.`,
  BLOCK_SELF: msg`You can't block yourself.`,
  DETACH_SELF: msg`You can't detach your own identity provider link.`,
  PURGE_SELF: msg`You can't delete yourself.`,
  FIELD_MANAGED_BY_IDP: msg`The identity provider manages this field. Change it there.`,
  LINK_NOT_DETACHABLE: msg`This link can't be detached.`,
  LINK_SOURCE_ACTIVE: msg`The identity provider still provisions this member. Remove them there first.`,
  LINK_SOURCE_SUSPENDED: msg`The identity provider has suspended this member's link.`,
  ROLE_INVALID: msg`That role can't be assigned.`,
  ROLE_MANAGED_BY_IDP: msg`This role comes from the identity provider. Change it there.`,
  ROLE_FROM_LOCAL_GROUP: msg`This role comes from a group. Change the group's mapping instead.`,
  GROUP_NOT_FOUND: msg`This group no longer exists.`,
  GROUP_NAME_TAKEN: msg`A group with this name already exists.`,
  MAPPING_NOT_FOUND: msg`This role mapping no longer exists.`,
  MAPPING_EXISTS: msg`This group already has that role.`,
  CONNECTION_NOT_FOUND: msg`This connection no longer exists.`,
  CONNECTION_NAME_TAKEN: msg`A connection with this name already exists.`,
  SSO_CONNECTION_NOT_FOUND: msg`This connection has no single sign-on.`,
  SSO_CONNECTION_ENV_OWNED: msg`This connection is configured by the server's settings and can't be changed here.`,
  SSO_CONNECTION_UNAVAILABLE: msg`This connection can't take single sign-on.`,
  SSO_DISCOVERY_URL_INVALID: msg`The discovery URL isn't valid.`,
  SSO_DISCOVERY_URL_UNTRUSTED: msg`The server doesn't trust the discovery URL's origin.`,
  SSO_IDENTITY_FIELD_IMMUTABLE: msg`This field identifies the identity provider and can't be changed.`,
  SSO_IDENTITY_FIELD_LOCKED: msg`People already sign in through this connection, so this field can't change.`,
  SSO_MATCH_CLAIM_LOCKED: msg`People already sign in through this connection, so the match claim can't change.`,
  SSO_PROTOCOL_MISMATCH: msg`These settings are for a different sign-in protocol.`,
  SSO_PROVIDER_ID_INVALID: msg`The provider ID can only use lowercase letters, numbers and hyphens.`,
  SSO_PROVIDER_ID_TAKEN: msg`A connection with this provider ID already exists.`,
  SCIM_CONNECTION_NOT_FOUND: msg`This connection has no active SCIM provisioning.`,
  SCIM_CONNECTION_UNAVAILABLE: msg`This connection can't take SCIM provisioning.`,
  SCIM_GROUP_NOT_FOUND: msg`This SCIM group no longer exists.`,
  SCIM_SIDE_NOT_RETIRED: msg`Retire SCIM provisioning on this connection first.`,
  INVALID_DOMAIN: msg`That isn't a valid domain.`,
  DOMAIN_NOT_FOUND: msg`This domain no longer exists.`,
  DOMAIN_NOT_VERIFIED: msg`Verify this domain first.`,
  DOMAIN_CLAIMED_BY_IDP: msg`An identity provider claims this domain.`,
  DOMAIN_EXISTS: msg`This domain has already been added.`,
  ALREADY_MEMBER: msg`This person is already a member.`,
  INVITATION_NOT_FOUND: msg`This invitation no longer exists.`,
  LINK_REVIEW_NOT_FOUND: msg`This review no longer exists.`,
  LINK_REVIEW_RESOLVED: msg`Someone has already decided this review.`,
  LINK_REVIEW_SELF: msg`You can't decide a review of your own account.`,
  LINK_REVIEW_RECORD_EXISTS: msg`The identity provider has already provisioned this person.`,
}

/** Why a domain's last verification check failed. */
export const domainCheckErrorMessages: Record<DomainCheckError, MessageDescriptor> = {
  TXT_RECORD_NOT_FOUND: msg`No verification record was found. DNS changes can take a while to appear.`,
  TXT_RECORD_MISMATCH: msg`A verification record was found, but its value doesn't match.`,
  DNS_LOOKUP_FAILED: msg`The DNS lookup failed. Try again later.`,
}

const genericError = msg`Something went wrong. Try again.`
const networkError = msg`Couldn't reach the server. Check your connection and try again.`

/** The message to show for a failed admin request: its code's message, or a generic one. */
export const getAdminErrorMessage = (error: unknown): MessageDescriptor => {
  if (error instanceof AdminApiError && error.code in adminErrorMessages) {
    return adminErrorMessages[error.code as AdminErrorCode]
  }
  if (error instanceof Error && isFetchNetworkError(error)) {
    return networkError
  }
  return genericError
}
