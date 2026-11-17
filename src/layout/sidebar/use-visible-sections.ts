/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { selectMinimalMode } from '@/api/config-store'
import { useConfigCapability } from '@/hooks/use-config-capability'
import { useIsAdmin } from '@/hooks/use-is-admin'
import type { SidebarSection } from './types'

/**
 * The sections the nav toggle offers. Minimal mode has no Settings (see `selectMinimalMode`), but
 * admins keep Admin there so a minimal deployment can still be administered.
 */
export const useVisibleSections = (): SidebarSection[] => {
  const minimalMode = useConfigCapability(selectMinimalMode)
  const isAdmin = useIsAdmin()
  return ['chats', ...(minimalMode ? [] : (['settings'] as const)), ...(isAdmin ? (['admin'] as const) : [])]
}
