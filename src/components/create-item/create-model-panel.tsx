/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddProviderModels } from '@/settings/models/add-provider-models'
import { useAddProviderModels } from '@/settings/models/use-add-provider-models'
import { CreateItemPanelShell } from './create-item-panel-shell'

type CreateModelPanelProps = {
  open: boolean
  onClose: () => void
  onCloseComplete: () => void
}

/** Adds a model over the current screen without changing routes. */
export const CreateModelPanel = ({ open, onClose, onCloseComplete }: CreateModelPanelProps) => {
  const addForm = useAddProviderModels({ isOpen: open, onClose })

  return (
    <CreateItemPanelShell
      kind="model"
      open={open}
      onClose={addForm.onCancel}
      onCloseComplete={onCloseComplete}
      bodyLayout="fill"
    >
      <AddProviderModels {...addForm} />
    </CreateItemPanelShell>
  )
}
