/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MobileSidebar } from '@/components/ui/mobile-sidebar'
import { SidebarProvider, useSidebar } from '@/components/ui/sidebar'
import { useSettings } from '@/hooks/use-settings'
import SidebarComponent from '@/layout/sidebar'
import { Outlet } from 'react-router'
import './index.css'

const LayoutContent = () => {
  const { isMobile, openMobile, setOpenMobile, notifyMobileSidebarCloseSettled } = useSidebar()

  return (
    <MobileSidebar
      enabled={isMobile}
      open={openMobile}
      onOpenChange={setOpenMobile}
      onCloseComplete={notifyMobileSidebarCloseSettled}
      onCloseCancel={notifyMobileSidebarCloseSettled}
      sidebar={<SidebarComponent />}
    >
      <div className="flex-1 overflow-hidden">
        <Outlet />
      </div>
    </MobileSidebar>
  )
}

const Layout = () => {
  const { sidebarState } = useSettings({
    sidebar_state: true,
  })

  const open = sidebarState.value
  const setOpen = (value: boolean) => sidebarState.setValue(value)

  // this avoids the sidebar from flashing after load sidebarState
  if (sidebarState.isLoading) {
    return null
  }

  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      <LayoutContent />
    </SidebarProvider>
  )
}

export default Layout
