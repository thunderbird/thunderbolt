/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The app's icon on a sidebar chat row.
 *
 * Chats from an app stay in the one chronological list rather than getting
 * their own section — they're still just chats, and a per-app group would
 * fragment the list for something the user thinks of as "the thing I asked
 * yesterday". The icon is enough to tell them apart at a glance.
 *
 * Renders nothing when the app isn't in the registry: a row is not the place to
 * explain that a deployment changed. The chat still opens, and its banner says
 * so there.
 */

import { findMiniApp } from './registry'
import { useMiniApps } from './use-mini-apps'

export const MiniAppChatBadge = ({ appId }: { appId: string }) => {
  const { apps } = useMiniApps()
  const app = findMiniApp(apps, appId)

  if (!app) {
    return null
  }

  return (
    <app.icon
      className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground"
      aria-label={`From ${app.name}`}
      role="img"
    />
  )
}
