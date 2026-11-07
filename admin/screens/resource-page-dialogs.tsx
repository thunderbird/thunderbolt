/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { useLingui } from '@lingui/react/macro'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { DiscardCreateDialog } from '@/skills/discard-create-dialog'
import type { ResourcePageState } from './use-resource-page-state'

export const ResourcePageDialogs = ({
  page,
  onRemove,
}: {
  page: ResourcePageState
  onRemove: (id: string) => void
}) => {
  const { t } = useLingui()
  return (
    <>
      <DiscardCreateDialog
        open={page.pendingSelection !== null}
        title={t`Discard unsaved changes?`}
        onOpenChange={(open) => !open && page.patch({ pendingSelection: null })}
        onConfirm={() => page.pendingSelection && page.select(page.pendingSelection.id)}
      />
      <ConfirmActionDialog
        open={page.removeId !== null}
        title={t`Remove from Thunderbolt?`}
        description={t`This item will no longer be available to the company's Thunderbolt agent.`}
        confirmLabel={t`Remove`}
        onCancel={() => page.patch({ removeId: null })}
        onConfirm={() => {
          if (page.removeId === null) {
            return
          }
          onRemove(page.removeId)
          if (page.selectedId === page.removeId) {
            page.select(null)
          }
          page.patch({ removeId: null })
        }}
      />
    </>
  )
}
