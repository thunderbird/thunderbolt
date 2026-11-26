/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { SquarePen, Trash2 } from 'lucide-react'
import type { ItemAction } from '../../components/item-actions'
import type { ResourcePageState } from '../../components/use-resource-page-state'

/** What an admin can do to a group, in its row's right-click menu and its panel's ⋯ menu. */
export const groupActions = (page: ResourcePageState, groupId: string): ItemAction[] => [
  { id: 'edit', label: <Trans>Edit</Trans>, icon: SquarePen, onSelect: () => page.edit(groupId) },
  {
    id: 'delete',
    label: <Trans>Delete</Trans>,
    icon: Trash2,
    onSelect: () => page.patch({ removeId: groupId }),
  },
]
