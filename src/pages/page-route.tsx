/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useEffectEvent, useLayoutEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { PagePanel } from './page-panel'
import { PageWindowNavigation } from './page-window-navigation'
import { pageController } from './page-controller'
import { pagePath, pageReturnPath } from './page-path'
import { usePageStore, type PageSession } from './page-store'
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
  const showExpanded = useEffectEvent((next: PageSession | null) => {
    if (!next) {
      navigate(pageReturnPath(location.state), { replace: true })
      return
    }
    usePageStore.getState().present(next.id, 'expanded')
    navigate(pagePath(next.page.id), { replace: true, state: location.state })
  })
  useLayoutEffect(() => {
    const abort = new AbortController()
    activate(abort.signal)
    const unregister = pageController.registerExpanded((next) => {
      // An in-flight saved-page restore belongs to the route being left, not the selected tab.
      abort.abort()
      showExpanded(next)
    })
    return () => {
      abort.abort()
      unregister()
    }
  }, [session?.id, saved?.id, saved?.updatedAt])
  const failed = failedPageId === pageId
  const pending = loading || Boolean(saved && !session && !failed)
  const restore = () => {
    if (session && usePageStore.getState().sessions.some((item) => item.id === session.id)) {
      pageController.restoreToSidebar(session.id)
    }
    navigate(pageReturnPath(location.state))
  }
  return (
    <div data-page-route className="flex h-full min-h-0 w-full flex-col pt-[var(--header-safe-area-top)]">
      {session ? (
        <PagePanel
          sessionId={session.id}
          mode="expanded"
          onRestore={restore}
          onClose={restore}
          headerStart={<PageWindowNavigation />}
        />
      ) : (
        <>
          <div className="flex shrink-0 p-2">
            <PageWindowNavigation />
          </div>
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
        </>
      )}
    </div>
  )
}
export default PageRoute
