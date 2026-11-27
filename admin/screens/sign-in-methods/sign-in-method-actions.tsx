/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { Archive, SquarePen, Trash2 } from 'lucide-react'
import type { AdminConnection, OrgDomain } from '@shared/admin-api'
import type { ItemAction } from '../../components/item-actions'
import type { ResourcePageState } from '../../components/use-resource-page-state'
import { describeConnection } from '../identity-providers/connection-status'
import { connectionEditId, domainEditId } from './sign-in-method-ids'

/**
 * What an admin can do to a connection, in its row's right-click menu and its panel's ⋯ menu: edit
 * an admin-created SSO side, retire its active SCIM side, and retire it once no SCIM side is active.
 */
export const connectionActions = (
  connection: Pick<AdminConnection, 'id' | 'sso' | 'scim' | 'status'>,
  page: ResourcePageState,
  onRetireScim: () => void,
): ItemAction[] => {
  const summary = describeConnection(connection)
  const id = connectionEditId(connection.id)
  return [
    ...(summary.canEditSso
      ? [{ id: 'edit', label: <Trans>Edit</Trans>, icon: SquarePen, onSelect: () => page.edit(id) }]
      : []),
    ...(summary.scim === 'active'
      ? [
          {
            id: 'retire-scim',
            label: <Trans>Retire SCIM</Trans>,
            icon: Archive,
            onSelect: onRetireScim,
          },
        ]
      : []),
    ...(summary.canRetireSso
      ? [
          {
            id: 'retire',
            label: <Trans>Retire</Trans>,
            icon: Archive,
            onSelect: () => page.patch({ removeId: id }),
          },
        ]
      : []),
  ]
}

/** What an admin can do to a domain: remove it, once its claim is released (the backend refuses before). */
export const domainActions = (domain: OrgDomain, page: ResourcePageState): ItemAction[] => [
  {
    id: 'remove',
    label: <Trans>Remove</Trans>,
    icon: Trash2,
    disabled: domain.claimedBy !== null,
    onSelect: () => page.patch({ removeId: domainEditId(domain.id) }),
  },
]
