import { EllipsisVertical, LogOut, Settings } from 'lucide-react'
import { type ButtonHTMLAttributes } from 'react'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { SidebarMenuButton } from './sidebar'

interface UserNavButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  username?: string
  userEmail?: string
}

export function UserNavButton({
  username = 'John Doe',
  userEmail = 'john.doe@example.com',
  className,
  ...props
}: UserNavButtonProps) {
  return (
    <SidebarMenuButton className={cn('relative', className)} {...props}>
      <Button variant="ghost" className="flex items-center gap-2 h-10 px-3 group">
        <div className="flex items-center gap-2">
          <div className="size-8 rounded-full bg-muted flex items-center justify-center overflow-hidden">
            <div className="text-sm font-medium">{username.charAt(0)}</div>
          </div>
          <div className="hidden md:block text-left">
            <p className="text-sm font-medium">{username}</p>
            <p className="text-xs text-muted-foreground">{userEmail}</p>
          </div>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <div onClick={(e) => e.stopPropagation()} className="ml-auto">
              <EllipsisVertical className="size-4 text-muted-foreground transition-transform group-hover:opacity-100 opacity-0" />
            </div>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-0" onClick={(e) => e.stopPropagation()}>
            <div className="py-1 px-2">
              <div className="mt-1 md:mt-0">
                <Button asChild variant="ghost" className="w-full justify-start">
                  <Link to="/settings/preferences">
                    <Settings className="size-4 mr-2" />
                    Settings
                  </Link>
                </Button>
                <Button variant="ghost" className="w-full justify-start text-destructive hover:text-destructive">
                  <LogOut className="size-4 mr-2" />
                  Logout
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </Button>
    </SidebarMenuButton>
  )
}
