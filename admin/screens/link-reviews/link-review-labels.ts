/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { LinkReview, LinkReviewStatus } from '@shared/admin-api'
import type { StatusTone } from '../../components/status-badge'

export const linkReviewStatusLabels: Record<LinkReviewStatus, MessageDescriptor> = {
  pending: msg`Pending`,
  approved: msg`Approved`,
  rejected: msg`Rejected`,
  linked: msg`Linked`,
}

export const linkReviewStatusTones: Record<LinkReviewStatus, StatusTone> = {
  pending: 'warning',
  approved: 'info',
  rejected: 'danger',
  linked: 'success',
}

export const linkReviewTriggerLabels: Record<LinkReview['trigger'], MessageDescriptor> = {
  sso_sign_in: msg`SSO sign-in`,
  scim_create_conflict: msg`SCIM provisioning`,
}
