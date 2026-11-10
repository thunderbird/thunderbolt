/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useLocation } from 'react-router'
import { PinOff } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar'
import { PageIcon } from './page-icon'
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
  return (
    <>
      {pages.map((page) => (
        <SidebarMenuItem key={page.id}>
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <SidebarMenuButton
                className="cursor-pointer"
                tooltip={page.title}
                isActive={pathname === pagePath(page.id)}
                onClick={() => {
                  const session = usePageStore.getState().sessions.find((item) => item.page.id === page.id)
                  if (session) {
                    usePageStore.getState().update(session.id, { chrome: page.chrome })
                    usePageStore.getState().present(session.id, 'expanded')
                  }
                  onClick(
                    page.id,
                    pathname.startsWith('/pages/')
                      ? pageReturnPath(location.state)
                      : location.pathname + location.search,
                  )
                }}
              >
                <PageIcon source={page.source} />
                <span>{page.title}</span>
              </SidebarMenuButton>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                onSelect={() => {
                  void mutation.remove(page.id).catch(() => {})
                }}
              >
                <PinOff />
                <Trans>Unpin</Trans>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </SidebarMenuItem>
      ))}
      {mutation.error && (
        <SidebarMenuItem role="alert" className="px-2 text-sm text-destructive">
          <Trans>Could not unpin this page. Please try again.</Trans>
        </SidebarMenuItem>
      )}
    </>
  )
}
