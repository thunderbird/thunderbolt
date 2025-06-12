import { useSidebar } from '@/components/ui/sidebar'
import { Menu } from 'lucide-react'

export function MobileHeader() {
  const { toggleSidebar } = useSidebar()

  return (
    <header className="flex md:hidden h-12 w-full items-center px-4 border-b">
      <button onClick={toggleSidebar} className="flex items-center justify-center w-8 h-8 rounded-md hover:bg-gray-100">
        <Menu className="h-5 w-5" />
      </button>
    </header>
  )
}
