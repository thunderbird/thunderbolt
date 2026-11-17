/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigCapability } from '@/hooks/use-config-capability'
import { selectMinimalMode } from '@/api/config-store'
import { SectionLayout } from '@/layout/section-layout'
import { Navigate } from 'react-router'

/**
 * Chrome around the settings pages. In minimal mode (see `selectMinimalMode`)
 * Settings is hidden and the sidebar offers no way in, so a deep link returns
 * to the chat home.
 */
const SettingsLayout = () => {
  const minimalMode = useConfigCapability(selectMinimalMode)
  if (minimalMode) {
    return <Navigate to="/chats/new" replace />
  }
  return <SectionLayout />
}

export default SettingsLayout
