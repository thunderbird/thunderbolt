/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { SsoProtocol } from '@shared/admin-api'
import type { StatusTone } from '../../components/status-badge'
import type { ConnectionSummary, ScimState } from './connection-status'

export const ssoLabels: Record<SsoProtocol, MessageDescriptor> = {
  oidc: msg`OIDC`,
  saml: msg`SAML`,
}

export const scimLabels: Record<ScimState, MessageDescriptor> = {
  active: msg`SCIM`,
  // The Retiring badge says the rest.
  retiring: msg`SCIM`,
  retired: msg`SCIM retired`,
}

export const envOwnedLabel = msg`Set by server settings`

/**
 * The badge beside a connection, only for a state worth flagging: retiring. An active one needs none,
 * and a retired one sits under its own heading.
 */
export const connectionBadge = (summary: ConnectionSummary): { tone: StatusTone; label: MessageDescriptor } | null =>
  !summary.retired && summary.scim === 'retiring' ? { tone: 'warning', label: msg`Retiring` } : null
