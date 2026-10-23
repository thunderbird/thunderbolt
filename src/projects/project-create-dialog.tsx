/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useRef, type RefObject } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MobileActionSheet } from '@/components/ui/mobile-action-sheet'
import { useDatabase } from '@/contexts'
import { createProject } from '@/dal/projects'
import { useIsMobile } from '@/hooks/use-mobile'
import { ProjectCreateForm } from './project-create-form'
import { useProjectCreateState } from './use-project-create-state'

/** A compact creation prompt; optional details stay in the project settings. */
export const ProjectCreateDialog = ({
  onClose,
  onCreated,
  returnFocusRef,
}: {
  onClose: () => void
  onCreated: (id: string) => void | Promise<void>
  returnFocusRef: RefObject<HTMLDivElement | null>
}) => {
  const { t } = useLingui()
  const db = useDatabase()
  const { isMobile } = useIsMobile()
  const inputRef = useRef<HTMLInputElement>(null)
  const form = useProjectCreateState(async (values) => {
    const project = await createProject(db, values)
    onClose()
    await onCreated(project.id)
  })
  const content = <ProjectCreateForm form={form} inputRef={inputRef} onCancel={onClose} />

  if (isMobile) {
    return (
      <MobileActionSheet
        open
        onOpenChange={(open) => !open && onClose()}
        title={t`Create project`}
        initialFocus={() => inputRef.current}
      >
        {content}
      </MobileActionSheet>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="sm:max-w-sm"
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          requestAnimationFrame(() => inputRef.current?.focus())
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (document.activeElement === document.body) {
            returnFocusRef.current?.querySelector('button')?.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            <Trans>Create project</Trans>
          </DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>
  )
}
