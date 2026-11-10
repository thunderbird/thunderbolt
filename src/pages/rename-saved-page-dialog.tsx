/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useMutation } from '@tanstack/react-query'
import { RenameDialog } from '@/components/rename-dialog'
import { useDatabase } from '@/contexts/database-context'
import { renameSavedPage } from './saved-pages'
import type { SavedPage } from './saved-page'

export const RenameSavedPageDialog = ({ page, onClose }: { page: SavedPage; onClose: () => void }) => {
  const { t } = useLingui()
  const db = useDatabase()
  const rename = useMutation({
    mutationFn: (name: string) => renameSavedPage(db, page.id, name),
    onSuccess: onClose,
  })
  return (
    <RenameDialog
      open
      name={page.title}
      title={t`Rename pinned page`}
      inputLabel={t`Page name`}
      maxLength={200}
      isPending={rename.isPending}
      error={rename.error && <Trans>Could not rename this page. Please try again.</Trans>}
      onRename={rename.mutate}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    />
  )
}
