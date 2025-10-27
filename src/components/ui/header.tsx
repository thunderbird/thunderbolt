import { Button } from '@/components/ui/button'
import { useSidebar } from '@/components/ui/sidebar'
import { useIsMobile } from '@/hooks/use-mobile'
import { Menu } from 'lucide-react'

/**
 * Reusable page header component with sidebar trigger and bottom border
 */
export const Header = () => {
  const { toggleSidebar } = useSidebar()
  const { isMobile } = useIsMobile()

  return (
    <header className="flex h-12 w-full items-center px-2 flex-shrink-0 border-b border-border">
      {isMobile && (
        <Button variant="ghost" size="icon" className="h-7 w-7 cursor-pointer" onClick={toggleSidebar}>
          <Menu className="h-5 w-5" />
          <span className="sr-only">Toggle Sidebar</span>
        </Button>
      )}
    </header>
  )
}
