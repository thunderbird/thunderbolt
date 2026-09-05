/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Where a chat should open.
 *
 * A chat that started inside an app belongs *in* that app. Reading it at
 * `/chats/:id` strands it: the model's answers are about a surface that isn't
 * on screen, and `get_app_context` has nothing to read because no frame is
 * mounted. So selecting one anywhere — sidebar, history, search — lands on the
 * app with that conversation already open beside it.
 *
 * Every reason to fall back to `/chats/:id` is a reason the app route wouldn't
 * work: the viewport can't host a split view, or the app has been deregistered
 * since. In those cases the chat still opens, and `MiniAppChatBanner` says where
 * it came from.
 *
 * An unanswered registry looks the same as a deregistered app from in here, so
 * callers that can afford to wait check `loading` first rather than acting on
 * that answer — see `ChatWithOrigin`.
 */

import { useIsMobile } from '@/hooks/use-mobile'
import { useCallback } from 'react'
import { findMiniApp } from './registry'
import { useMiniApps } from './use-mini-apps'

/** `/apps/:appId?chat=:chatThreadId` — the app, with one conversation open. */
export const miniAppChatPath = (appId: string, chatThreadId: string): string =>
  `/apps/${encodeURIComponent(appId)}?chat=${encodeURIComponent(chatThreadId)}`

export const useChatDestination = (): ((chatThreadId: string, miniAppId?: string | null) => string) => {
  const { apps } = useMiniApps()
  const { isMobile } = useIsMobile()

  return useCallback(
    (chatThreadId, miniAppId) => {
      if (!miniAppId || isMobile || !findMiniApp(apps, miniAppId)) {
        return `/chats/${chatThreadId}`
      }
      return miniAppChatPath(miniAppId, chatThreadId)
    },
    [apps, isMobile],
  )
}
