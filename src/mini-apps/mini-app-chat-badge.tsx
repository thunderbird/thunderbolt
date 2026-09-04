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

import { useLingui } from '@lingui/react/macro'

import { useSettings } from '@/hooks/use-settings'
import { findMiniApp } from './registry'
import { useMiniApps } from './use-mini-apps'

/** The icon itself, for a device where Mini Apps are on. */
const MiniAppChatBadgeIcon = ({ appId }: { appId: string }) => {
  const { t } = useLingui()
  const { apps } = useMiniApps()
  const app = findMiniApp(apps, appId)

  if (!app) {
    return null
  }

  return (
    <app.icon
      className="size-[var(--icon-size-sm)] shrink-0 text-muted-foreground"
      aria-label={t`From ${app.name}`}
      role="img"
    />
  )
}

export const MiniAppChatBadge = ({ appId }: { appId: string }) => {
  const { experimentalFeatureMiniApps } = useSettings({ experimental_feature_mini_apps: false })

  // Chats sync; the feature flag doesn't. The same reasoning as
  // `MiniAppChatBanner`: a chat started where Mini Apps are on can land on a
  // device where they're off, and `/apps/:appId` isn't even a route there — so
  // painting an app's iconography on the row points at a door that isn't there.
  //
  // A wrapper rather than an early return inside the icon, so a flag-off device
  // doesn't mount `useMiniApps` at all. Not fetching is `useMiniApps`'s own job
  // now — this only keeps a subscription off a row that draws nothing.
  if (!experimentalFeatureMiniApps.value) {
    return null
  }

  return <MiniAppChatBadgeIcon appId={appId} />
}
