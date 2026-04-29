/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { Slot } from '@radix-ui/react-slot'
import { Ellipsis, Trash2 } from 'lucide-react'
import { type HTMLAttributes } from 'react'
import { useNavigate } from 'react-router'

type ChatNavButtonProps = HTMLAttributes<HTMLDivElement> & {
  chatTitle: string
  threadId: string
  asChild?: boolean
}

export const ChatNavButton = ({ chatTitle, threadId, className, asChild = false, ...props }: ChatNavButtonProps) => {
  const Comp = asChild ? Slot : 'div'
  const navigate = useNavigate()

  const handleButtonClick = () => {
    navigate(`/chats/${threadId}`)
  }

  return (
    <Comp className={cn('relative w-full group/chat', className)} {...props}>
      <div className="w-full h-full flex space-x-2 items-center">
        <div className="h-9 relative">
          <div className="w-1 h-[100%] bg-gray-200 group-hover/chat:opacity-100 opacity-0 rounded-r-sm" />
        </div>
        <div className="flex items-center w-full">
          <Button
            variant="ghost"
            className="flex items-center justify-between gap-2 h-[var(--touch-height-lg)] px-3 w-full"
            onClick={handleButtonClick}
          >
            <div className="flex items-center gap-2">
              <div className="hidden md:block text-left">
                <p className="text-sm font-base">{chatTitle}</p>
              </div>
            </div>

            <Popover>
              <PopoverTrigger asChild>
                <div onClick={(e) => e.stopPropagation()} className="ml-auto">
                  <Ellipsis className="size-4 text-muted-foreground transition-transform group-hover/chat:opacity-100 opacity-0 cursor-pointer" />
                </div>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-0" onClick={(e) => e.stopPropagation()}>
                <div className="py-1 px-2">
                  <div className="mt-1 md:mt-0">
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          className="w-full justify-start text-destructive hover:text-destructive"
                        >
                          <Trash2 className="size-4 mr-2" />
                          Delete
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete the thread?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This action cannot be undone. This will permanently delete this chat and all its messages.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction className={cn(buttonVariants({ variant: 'destructive' }))}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </Button>
        </div>
      </div>
    </Comp>
  )
}
