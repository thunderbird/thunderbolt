/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { DetailPanel } from '@/components/detail-panel'
import { AddModelForm } from '@/settings/models/add-model-form'
import { useAddModelForm } from '@/settings/models/use-add-model-form'
import { CreateItemSurface } from './create-item-surface'

type CreateModelPanelProps = {
  open: boolean
  onClose: () => void
}

/** Adds a model over the current screen without changing routes. */
export const CreateModelPanel = ({ open, onClose }: CreateModelPanelProps) => {
  const addForm = useAddModelForm({ active: open, onClose })

  return (
    <CreateItemSurface open={open} onClose={addForm.onCancel}>
      <DetailPanel title="Add Model" onClose={addForm.onCancel}>
        <AddModelForm {...addForm} />
      </DetailPanel>
    </CreateItemSurface>
  )
}
