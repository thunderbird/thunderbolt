/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { OAuthProvider } from '@/lib/auth'
import type { ReactNode } from 'react'

/**
 * A pre-baked (non-MCP) connection shown at the top of the Connections list:
 * the built-in Thunderbolt tools plus the Google/Microsoft OAuth integrations.
 */
export type Integration = {
  id: string
  name: string
  provider: 'thunderbolt-pro' | OAuthProvider
  connectLabel: string
  icon: ReactNode
  isEnabled: boolean
  isConnected: boolean
  userEmail?: string
}
