/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { MobileActionSheet, MobileActionSheetFooter } from '@/components/ui/mobile-action-sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { defaultChatTitle } from '@/lib/constants'
import { useRef, useState } from 'react'

type RenameChatDialogProps = {
  open: boolean
  title: string | null
  onOpenChange: (open: boolean) => void
  onRename: (title: string) => void
}

const RenameChatForm = ({ open, title, onOpenChange, onRename }: RenameChatDialogProps) => {
  const { isMobile } = useIsMobile()
  const initialTitle = title ?? defaultChatTitle
  const [value, setValue] = useState(initialTitle)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousOpenRef = useRef(open)

  if (open !== previousOpenRef.current) {
    previousOpenRef.current = open
    if (open && value !== initialTitle) {
      setValue(initialTitle)
    }
  }

  const focusInput = () => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }

  const handleSave = () => {
    const trimmed = value.trim()
    const newTitle = trimmed || defaultChatTitle
    if (newTitle !== initialTitle) {
      onRename(newTitle)
    }
    onOpenChange(false)
  }

  const input = (
    <Input
      ref={inputRef}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          handleSave()
        }
      }}
      aria-label="Chat name"
      placeholder="Chat name"
    />
  )

  const actions = (
    <>
      <Button variant="outline" onClick={() => onOpenChange(false)}>
        Cancel
      </Button>
      <Button onClick={handleSave}>Save</Button>
    </>
  )

  if (isMobile) {
    return (
      <MobileActionSheet
        open={open}
        onOpenChange={onOpenChange}
        title="Rename chat"
        initialFocus={() => {
          focusInput()
          return false
        }}
      >
        {input}
        <MobileActionSheetFooter>{actions}</MobileActionSheetFooter>
      </MobileActionSheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // The dialog opens from a menu item, whose closing focus restoration
          // runs after this event and can otherwise move focus back to the menu.
          requestAnimationFrame(focusInput)
        }}
      >
        <DialogHeader>
          <DialogTitle>Rename chat</DialogTitle>
        </DialogHeader>
        {input}
        <DialogFooter>{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The `key` remounts the form whenever the chat title changes so the draft
// value always starts from the current title.
export const RenameChatDialog = (props: RenameChatDialogProps) => <RenameChatForm key={props.title} {...props} />
