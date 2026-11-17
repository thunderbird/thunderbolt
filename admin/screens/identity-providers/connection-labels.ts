/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { SsoProtocol } from '@shared/admin-api'
import type { StatusTone } from '../../components/status-badge'
import type { ConnectionSummary, ScimState } from './connection-status'

export const ssoLabels: Record<SsoProtocol, MessageDescriptor> = {
  oidc: msg`OIDC sign-in`,
  saml: msg`SAML sign-in`,
}

export const scimLabels: Record<ScimState, MessageDescriptor> = {
  active: msg`SCIM provisioning`,
  retiring: msg`SCIM retiring`,
  retired: msg`SCIM retired`,
}

export const envOwnedLabel = msg`Set by server settings`

/** The badge beside a connection: whether it still signs people in or provisions them. */
export const connectionBadge = (summary: ConnectionSummary): { tone: StatusTone; label: MessageDescriptor } => {
  if (summary.retired) {
    return { tone: 'neutral', label: msg`Retired` }
  }
  if (summary.scim === 'retiring') {
    return { tone: 'warning', label: msg`Retiring` }
  }
  return { tone: 'success', label: msg`Active` }
}
