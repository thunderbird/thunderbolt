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

/**
 * The banner itself, given an already-resolved app. Presentational.
 *
 * `max-md:pt-…` clears the floating header (THU-907). `FloatingHeader` is
 * `absolute top-0` with a scrim beneath it, and the convention is that pages
 * pad by `--header-inset` where they need to. The chat transcript deliberately
 * does not — it fades under the scrim — but this banner is a solid bordered
 * strip pinned to the top, so it was drawn underneath the sidebar toggle and
 * the logo, its title half-hidden behind them.
 *
 * Mobile only: below the breakpoint the header is always drawn, so this is
 * exactly where it overlaps. Desktop keeps its current spacing.
 */
export const MiniAppOriginNotice = ({ app, chatThreadId, canOpen }: MiniAppOriginNoticeProps) => (
  <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[length:var(--font-size-sm)] text-muted-foreground max-md:pt-[calc(var(--header-inset)+0.5rem)]">
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
