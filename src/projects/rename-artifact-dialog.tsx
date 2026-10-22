/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, useState } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { MobileActionSheet, MobileActionSheetFooter } from '@/components/ui/mobile-action-sheet'
import { maxArtifactTitleLength } from '@/dal/project-artifact-presentation'
import { useIsMobile } from '@/hooks/use-mobile'

type RenameArtifactDialogProps = {
  title: string
  error: string | null
  isPending: boolean
  onSave: (title: string) => void
  onClose: () => void
}

export const RenameArtifactDialog = ({ title, error, isPending, onSave, onClose }: RenameArtifactDialogProps) => {
  const { t } = useLingui()
  const { isMobile } = useIsMobile()
  const [value, setValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  const save = () => {
    if (value.trim() && !isPending) {
      onSave(value.trim())
    }
  }
  const input = (
    <>
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            save()
          }
        }}
        aria-label={t`Artifact name`}
        maxLength={maxArtifactTitleLength}
        disabled={isPending}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
  const actions = (
    <>
      <Button variant="outline" onClick={onClose} disabled={isPending}>
        <Trans>Cancel</Trans>
      </Button>
      <Button onClick={save} disabled={!value.trim()} isLoading={isPending}>
        <Trans>Save</Trans>
      </Button>
    </>
  )
  if (isMobile) {
    return (
      <MobileActionSheet
        open
        onOpenChange={(open) => {
          if (!open) {
            onClose()
          }
        }}
        title={t`Rename artifact`}
        initialFocus={() => {
          requestAnimationFrame(() => inputRef.current?.select())
          return inputRef.current
        }}
      >
        {input}
        <MobileActionSheetFooter>{actions}</MobileActionSheetFooter>
      </MobileActionSheet>
    )
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Rename artifact</Trans>
          </DialogTitle>
        </DialogHeader>
        {input}
        <DialogFooter>{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
