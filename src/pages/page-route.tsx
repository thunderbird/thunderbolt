/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useEffect, useEffectEvent, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { useIsMobile } from '@/hooks/use-mobile'
import { sharedHeaderHasControls } from '@/layout/shared-header'
import { isTauriDesktop } from '@/lib/platform'
import { cn } from '@/lib/utils'
import { PagePanel } from './page-panel'
import { pageController } from './page-controller'
import { pageReturnPath } from './page-path'
import { usePageStore } from './page-store'
import { useSavedPages } from './use-saved-pages'
import { restoreSavedPage } from './restore-saved-page'

const PageRoute = () => {
  const { pageId } = useParams()
  const [failedPageId, setFailedPageId] = useState<string | null>(null)
  const sessions = usePageStore((state) => state.sessions)
  const session = sessions.find((item) => item.page.id === pageId)
  const { pages, loading, error } = useSavedPages()
  const saved = pages.find((page) => page.id === pageId)
  const location = useLocation()
  const navigate = useNavigate()
  const { isMobile } = useIsMobile()
  const inset = sharedHeaderHasControls({ pathname: location.pathname, isMobile, isDesktopApp: isTauriDesktop() })
  // Route subscriptions may resolve a synced pin after navigation or cold start.
  const activate = useEffectEvent((signal: AbortSignal) => {
    if (session) {
      usePageStore.getState().present(session.id, 'expanded')
      return
    }
    if (saved) {
      const open = async () => {
        try {
          const id = await restoreSavedPage(saved, signal)
          if (!signal.aborted) {
            usePageStore.getState().present(id, 'expanded')
          }
        } catch {
          if (!signal.aborted) {
            setFailedPageId(saved.id)
          }
        }
      }
      void open()
    }
  })
  useEffect(() => {
    const abort = new AbortController()
    activate(abort.signal)
    return () => abort.abort()
  }, [session?.id, saved?.id, saved?.updatedAt])
  const failed = failedPageId === pageId
  const pending = loading || Boolean(saved && !session && !failed)
  const restore = () => {
    if (session && usePageStore.getState().sessions.some((item) => item.id === session.id)) {
      pageController.select(session.id)
    }
    navigate(pageReturnPath(location.state))
  }
  return (
    <div data-page-route className={cn('flex h-full min-h-0 w-full flex-col', inset && 'pt-[var(--header-inset)]')}>
      {session ? (
        <PagePanel sessionId={session.id} mode="expanded" onRestore={restore} onClose={restore} />
      ) : (
        <div className="m-auto space-y-4 p-6 text-center text-sm text-muted-foreground">
          <p>
            {pending ? (
              <Trans>Loading page…</Trans>
            ) : error || failed ? (
              <Trans>Could not load this page.</Trans>
            ) : (
              <Trans>This page is no longer available.</Trans>
            )}
          </p>
          {!pending && (
            <Button variant="outline" onClick={() => navigate(pageReturnPath(location.state))}>
              <Trans>Back to chat</Trans>
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
export default PageRoute
