/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { AccessRefusal, MembershipSourceKind, MembershipSourceStatus } from '@shared/admin-api'

/** Why a member can't sign in, in words. */
export const accessRefusalLabels: Record<AccessRefusal, MessageDescriptor> = {
  not_member: msg`Not a member of this organization`,
  blocked: msg`Blocked by an admin`,
  deprovisioned: msg`Removed by the identity provider`,
  no_live_source: msg`No active sign-in method`,
  sso_required: msg`Can only sign in through single sign-on`,
}

/** How a member came into the organization. */
export const sourceKindLabels: Record<MembershipSourceKind, MessageDescriptor> = {
  scim: msg`SCIM provisioning`,
  sso: msg`Single sign-on`,
  invitation: msg`Invitation`,
  domain: msg`Organization domain`,
  waitlist: msg`Waitlist`,
  open: msg`Open sign-up`,
  local: msg`Added by an admin`,
  bootstrap: msg`Bootstrap admin`,
}

export const sourceStatusLabels: Record<MembershipSourceStatus, MessageDescriptor> = {
  active: msg`Active`,
  suspended: msg`Suspended`,
  removed: msg`Removed`,
}
