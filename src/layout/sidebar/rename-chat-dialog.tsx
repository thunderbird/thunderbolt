/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
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

export const RenameChatDialog = ({ open, title, onOpenChange, onRename }: RenameChatDialogProps) => {
  const { t } = useLingui()
  const { isMobile } = useIsMobile()
  const initialTitle = title ?? defaultChatTitle
  const [value, setValue] = useState(initialTitle)
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset the draft to the current title on each open (the sanctioned
  // previous-value-in-state pattern, so a discarded StrictMode/concurrent
  // render can't lose the reset).
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
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

  const handleCancel = () => {
    inputRef.current?.blur()
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
      aria-label={t`Chat name`}
      placeholder={t`Chat name`}
    />
  )

  const actions = (
    <>
      <Button
        variant="outline"
        onPointerDown={(event) => {
          if (event.pointerType === 'touch') {
            event.preventDefault()
            handleCancel()
          }
        }}
        onClick={handleCancel}
      >
        <Trans>Cancel</Trans>
      </Button>
      <Button onClick={handleSave}>
        <Trans>Save</Trans>
      </Button>
    </>
  )

  if (isMobile) {
    return (
      <MobileActionSheet
        open={open}
        onOpenChange={onOpenChange}
        title={t`Rename chat`}
        initialFocus={() => {
          const input = inputRef.current
          requestAnimationFrame(() => input?.select())
          return input
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
          <DialogTitle>
            <Trans>Rename chat</Trans>
          </DialogTitle>
        </DialogHeader>
        {input}
        <DialogFooter>{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
