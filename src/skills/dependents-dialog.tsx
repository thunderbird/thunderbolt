/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plural, Trans } from '@lingui/react/macro'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { Skill } from '@/types'

export type DependentsAction = 'disable' | 'delete'

// A whole message per action rather than a verb interpolated into a sentence:
// injecting a translated verb (or, as before, the raw action id) into a
// translated frame gets the grammar wrong in most languages.

export const DependentsDialog = ({
  open,
  onOpenChange,
  action,
  targetName,
  dependents,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  action: DependentsAction
  /** Human display name of the skill being disabled/deleted. */
  targetName: string
  dependents: Skill[]
  onConfirm: () => void
}) => {
  const count = dependents.length

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {action === 'disable' ? <Trans>Disable {targetName}?</Trans> : <Trans>Delete {targetName}?</Trans>}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {action === 'disable' ? (
              <Plural
                value={count}
                one="One skill references this. If you disable it, that skill may no longer resolve."
                other="# skills reference this. If you disable it, they may no longer resolve."
              />
            ) : (
              <Plural
                value={count}
                one="One skill references this. If you delete it, that skill may no longer resolve."
                other="# skills reference this. If you delete it, they may no longer resolve."
              />
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>
            <Trans>Cancel</Trans>
          </AlertDialogCancel>
          <Button variant="destructive" onClick={onConfirm}>
            {action === 'disable' ? <Trans>Disable skill</Trans> : <Trans>Delete skill</Trans>}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
