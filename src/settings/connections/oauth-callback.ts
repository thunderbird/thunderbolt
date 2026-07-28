/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { isMcpOAuthCallback } from '@/lib/mcp-auth/mcp-oauth-state'
import type { McpOAuthCallback } from '@/hooks/use-mcp-server-oauth'

export type ConnectionsOAuthCallback =
  | { kind: 'none' }
  | { kind: 'mcp'; callback: McpOAuthCallback }
  | { kind: 'integration'; callback: McpOAuthCallback }

/** Classifies router state without coupling callback processing to React. */
export const getConnectionsOAuthCallback = (state: unknown): ConnectionsOAuthCallback => {
  const oauth = (state as { oauth?: McpOAuthCallback } | null)?.oauth
  if (!oauth) {
    return { kind: 'none' }
  }
  return isMcpOAuthCallback({ code: oauth.code, state: oauth.state, error: oauth.error })
    ? { kind: 'mcp', callback: oauth }
    : { kind: 'integration', callback: oauth }
}
