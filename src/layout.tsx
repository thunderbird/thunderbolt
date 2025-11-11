import { SidebarProvider } from '@/components/ui/sidebar'
import SidebarComponent from '@/layout/sidebar'
import { useEffect, useState } from 'react'
import { Outlet } from 'react-router'
import './index.css'

export default function Layout() {
  // Initialize sidebar state from localStorage
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem('sidebar-state')
      return saved ? JSON.parse(saved) : true
    } catch {
      return true
    }
  })

  // Sync sidebar state to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('sidebar-state', JSON.stringify(open))
  }, [open])

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
