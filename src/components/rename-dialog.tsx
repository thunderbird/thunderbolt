/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { MobileActionSheet, MobileActionSheetFooter } from '@/components/ui/mobile-action-sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { useRef, useState, type ReactNode } from 'react'

type RenameDialogProps = {
  open: boolean
  name: string
  title: string
  inputLabel: string
  fallbackName?: string
  maxLength?: number
  isPending?: boolean
  error?: ReactNode
  onOpenChange: (open: boolean) => void
  onRename: (name: string) => void
}

/** Shared rename form, with the same focus and mobile-sheet behavior for chats and pinned pages. */
export const RenameDialog = ({
  open,
  name,
  title,
  inputLabel,
  fallbackName,
  maxLength,
  isPending = false,
  error,
  onOpenChange,
  onRename,
}: RenameDialogProps) => {
  const { isMobile } = useIsMobile()
  const initialTitle = name
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
    const newTitle = trimmed || fallbackName
    if (!newTitle || isPending) {
      return
    }
    if (newTitle === initialTitle) {
      onOpenChange(false)
      return
    }
    onRename(newTitle)
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
      aria-label={inputLabel}
      placeholder={inputLabel}
      maxLength={maxLength}
      disabled={isPending}
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
      <Button onClick={handleSave} disabled={isPending || (!value.trim() && !fallbackName)}>
        <Trans>Save</Trans>
      </Button>
    </>
  )

  if (isMobile) {
    return (
      <MobileActionSheet
        open={open}
        onOpenChange={onOpenChange}
        title={title}
        initialFocus={() => {
          const input = inputRef.current
          requestAnimationFrame(() => input?.select())
          return input
        }}
      >
        {input}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <MobileActionSheetFooter>{actions}</MobileActionSheetFooter>
      </MobileActionSheet>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-sm"
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          // The dialog opens from a menu item, whose closing focus restoration
          // runs after this event and can otherwise move focus back to the menu.
          requestAnimationFrame(focusInput)
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {input}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
