import { SidebarProvider } from '@/components/ui/sidebar'
import { useSettings } from '@/hooks/use-settings'
import SidebarComponent from '@/layout/sidebar'
import { Outlet } from 'react-router'
import './index.css'

export default function Layout() {
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
      <main className="flex flex-row h-full w-full overflow-hidden">
        <SidebarComponent />
        <div className="flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>
    </SidebarProvider>
  )
}
