/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * "This chat came from <app>" — shown above a chat opened from the sidebar.
 *
 * Only on the standalone `/chats/:id` route. Beside the app itself the
 * provenance is the screen, and a banner restating it would be noise.
 *
 * The app may no longer be registered: the registry is deployment config, and
 * the chat outlives whatever it was started from. That case is stated plainly
 * rather than hidden, because the alternative is a chat that references a tool
 * the user can't find, with no explanation of why.
 */

import { Trans } from '@lingui/react/macro'
import { Link } from 'react-router'

import { useIsMobile } from '@/hooks/use-mobile'
import { findMiniApp, type MiniAppDefinition } from './registry'
import { miniAppChatPath } from './use-chat-destination'
import { useMiniApps } from './use-mini-apps'

type MiniAppOriginNoticeProps = {
  /** The originating app, or null when it is no longer registered. */
  app: MiniAppDefinition | null
  /** Carried into the app so "Open app" reopens this chat beside it. */
  chatThreadId: string
  /** False at mobile widths, where the app route only renders a size notice —
   *  the provenance is still worth saying, the link is not. */
  canOpen: boolean
}

/** The banner itself, given an already-resolved app. Presentational. */
export const MiniAppOriginNotice = ({ app, chatThreadId, canOpen }: MiniAppOriginNoticeProps) => (
  <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[length:var(--font-size-sm)] text-muted-foreground">
    {app ? (
      <>
        <app.icon className="size-[var(--icon-size-sm)] shrink-0" aria-hidden="true" />
        <span className="truncate">
          <Trans>Started from {app.name}</Trans>
        </span>
        {canOpen && (
          <Link
            to={miniAppChatPath(app.id, chatThreadId)}
            className="ml-auto shrink-0 underline underline-offset-2 hover:text-foreground"
          >
            <Trans>Open app</Trans>
          </Link>
        )}
      </>
    ) : (
      <span className="truncate">
        <Trans>Started from an app that is no longer available</Trans>
      </span>
    )}
  </div>
)

type MiniAppChatBannerProps = {
  appId: string
  chatThreadId: string
}

export const MiniAppChatBanner = ({ appId, chatThreadId }: MiniAppChatBannerProps) => {
  const { isMobile } = useIsMobile()
  const { apps, loading, failed } = useMiniApps()

  // The registry arrives over the network. Rendering "no longer available"
  // while it's still in flight — or after the fetch simply failed — would
  // accuse a healthy app of being gone on every chat that came from it.
  if (loading || failed) {
    return null
  }

  return <MiniAppOriginNotice app={findMiniApp(apps, appId) ?? null} chatThreadId={chatThreadId} canOpen={!isMobile} />
}
