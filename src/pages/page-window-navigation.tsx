/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { PanelLeftRounded } from '@/components/icons/panel-left-rounded'
import { HistoryNavButtons } from '@/components/ui/history-nav-buttons'
import { useSidebar } from '@/components/ui/sidebar'
import { BrowserToolbarButton } from '@/content-view/browser-toolbar-button'
import { useIsMobile } from '@/hooks/use-mobile'
import { isMacDesktop, isTauriDesktop } from '@/lib/platform'
import { cn } from '@/lib/utils'

/** Keep app navigation and the collapsed sidebar accessible inside the page's tab row. */
export const PageWindowNavigation = () => {
  const { t } = useLingui()
  const { isMobile } = useIsMobile()
  const { toggleSidebar, state, forceCollapsed } = useSidebar()
  if (!isMobile && !isTauriDesktop()) {
    return null
  }
  const macCollapsed = isMacDesktop() && !isMobile && state === 'collapsed'
  return (
    <div data-page-window-navigation className={cn('flex shrink-0 items-center', macCollapsed && 'ml-8')}>
      {(isMobile || (macCollapsed && !forceCollapsed)) && (
        <BrowserToolbarButton label={isMobile ? t`Toggle Sidebar` : t`Expand Sidebar`} onClick={toggleSidebar}>
          <PanelLeftRounded className="size-4" />
        </BrowserToolbarButton>
      )}
      {isTauriDesktop() && <HistoryNavButtons />}
    </div>
  )
}
