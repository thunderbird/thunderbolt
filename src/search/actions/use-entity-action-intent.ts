/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConsumeNavState } from '@/hooks/use-consume-nav-state'
import { getEntityActions } from './entity-actions'
import type { EntityActionIntent } from './types'
import type { SearchEntityType } from '../types'

type EntityActionHandlers = {
  onCreate?: () => void
  onEdit?: (id: string) => void
  onRemove?: (id: string) => void
}

/**
 * Consume a one-shot palette action intent on a settings page and dispatch
 * it to the page's existing create/edit/remove handlers (THU-768).
 *
 * The intent arrives JSON-encoded in `location.state` under the entity's
 * configured `stateKey` (see {@link buildActionNav}); this hook decodes it
 * and routes by `type`. When the entity has no action config the hook still
 * calls `useConsumeNavState` against an inert key so hook order stays stable.
 */
export const useEntityActionIntent = (entityType: SearchEntityType, handlers: EntityActionHandlers): void => {
  const cfg = getEntityActions(entityType)
  const stateKey = cfg?.stateKey ?? `__noop:${entityType}`

  useConsumeNavState(stateKey, (raw) => {
    const intent = JSON.parse(raw) as EntityActionIntent
    if (intent.type === 'create') {
      return handlers.onCreate?.()
    }
    if (intent.type === 'edit' && intent.id) {
      return handlers.onEdit?.(intent.id)
    }
    if (intent.type === 'remove' && intent.id) {
      return handlers.onRemove?.(intent.id)
    }
  })
}
