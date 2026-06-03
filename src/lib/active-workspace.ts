/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getPersonalWorkspaceByOwner } from '@/dal'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import { getActiveUserId } from '@/stores/trust-domain-registry'

/**
 * Best-effort match for the workspace id segment in URLs shaped like
 * `/w/<workspaceId>/...`. PR 3 introduces this routing; today no route uses
 * the `/w/...` prefix, so this is effectively a no-op feature flag — when the
 * routes land, this picks them up without further changes.
 */
const matchWorkspaceIdInPath = (pathname: string): string | null => {
  const match = pathname.match(/^\/w\/([^/]+)/)
  return match?.[1] ?? null
}

/**
 * Resolve the active workspace id for the current user.
 *
 * Source of truth, in order:
 *   1. URL path (`/w/<id>/...`) — populated by PR 3's workspace selector.
 *   2. The user's personal workspace from the local DB.
 *
 * Returns `null` when there's no active user (caller is unauthenticated) or
 * the personal workspace hasn't been created yet (pre-bootstrap). Consumers
 * that require a workspace context should either await the bootstrap signal
 * (`<WorkspaceGate>`) or handle the null case explicitly.
 *
 * Async because the personal-workspace fallback hits SQLite. The lookup is a
 * single-row `SELECT` on an indexed column — <1ms locally.
 */
export const getActiveWorkspaceId = async (db: AnyDrizzleDatabase): Promise<string | null> => {
  const fromUrl = matchWorkspaceIdInPath(window.location.pathname)
  if (fromUrl) {
    return fromUrl
  }
  const userId = getActiveUserId()
  if (!userId) {
    return null
  }
  const personal = await getPersonalWorkspaceByOwner(db, userId)
  return personal?.id ?? null
}
