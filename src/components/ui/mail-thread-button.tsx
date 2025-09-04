import { Ellipsis, Mails, Trash2 } from 'lucide-react'
import { type HTMLAttributes } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

interface MailThreadButtonProps extends HTMLAttributes<HTMLDivElement> {
  mailTitle: string
}

export function MailThreadButton({ mailTitle, className, ...props }: MailThreadButtonProps) {
  return (
    <div className={cn('relative w-full', className)} {...props}>
      <Popover>
        <PopoverTrigger asChild>
          <div className="group w-full h-full flex space-x-2 items-center">
            <div className="group h-8 relative">
              <div className="w-1 h-[100%] bg-gray-700 group-hover:bg-gray-500 rounded-r-sm" />
            </div>

            <Button variant="ghost" className="flex items-center gap-2 h-10 px-3 group w-full">
              <div className="flex items-center gap-2">
                <Mails className="size-4" />
                <div className="hidden md:block text-left">
                  <p className="text-sm font-base">{mailTitle}</p>
                </div>
              </div>
              <Ellipsis className="size-4 text-muted-foreground transition-transform group-hover:opacity-100 opacity-0 ml-auto" />
            </Button>
          </div>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0">
          <div className="py-1 px-2">
            <div className="mt-1 md:mt-0">
              <Button variant="ghost" className="w-full justify-start text-destructive hover:text-destructive">
                <Trash2 className="size-4 mr-2" />
                Delete
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
