/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useLocation } from 'react-router'
import { useState } from 'react'
import { SidebarMenuItem } from '@/components/ui/sidebar'
import { SavedPageMenuItem } from './saved-page-menu-item'
import { RenameSavedPageDialog } from './rename-saved-page-dialog'
import type { SavedPage } from './saved-page'
import { pagePath, pageReturnPath } from './page-path'
import { useSavePage, useSavedPages } from './use-saved-pages'
import { usePageStore } from './page-store'

/** Synced page shortcuts and device-local applications share the same navigation. */
export const SavedPageMenuItems = ({
  pathname,
  onClick,
}: {
  pathname: string
  onClick: (pageId: string, returnTo: string) => void
}) => {
  const location = useLocation()
  const { pages } = useSavedPages()
  const mutation = useSavePage()
  const [renamingPage, setRenamingPage] = useState<SavedPage | null>(null)
  return (
    <>
      {pages.map((page) => (
        <SavedPageMenuItem
          key={page.id}
          page={page}
          active={pathname === pagePath(page.id)}
          onRename={() => setRenamingPage(page)}
          onUnpin={() => {
            void mutation.remove(page.id).catch(() => {})
          }}
          onOpen={() => {
            const session = usePageStore.getState().sessions.find((item) => item.page.id === page.id)
            if (session) {
              usePageStore.getState().update(session.id, { chrome: page.chrome })
              usePageStore.getState().present(session.id, 'expanded')
            }
            onClick(
              page.id,
              pathname.startsWith('/pages/') ? pageReturnPath(location.state) : location.pathname + location.search,
            )
          }}
        />
      ))}
      {renamingPage && <RenameSavedPageDialog page={renamingPage} onClose={() => setRenamingPage(null)} />}
      {mutation.error && (
        <SidebarMenuItem role="alert" className="px-2 text-sm text-destructive">
          <Trans>Could not unpin this page. Please try again.</Trans>
        </SidebarMenuItem>
      )}
    </>
  )
}
