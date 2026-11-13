/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useLingui } from '@lingui/react/macro'
import { DetailPanel } from '@/components/detail-panel'
import { AddProviderModels } from './add-provider-models'
import { useAddProviderModels } from './use-add-provider-models'

/** Own the catalog draft in the aside, without rerendering the saved model list. */
export const AddProviderModelsPanel = ({ onClose }: { onClose: () => void }) => {
  const { t } = useLingui()
  const state = useAddProviderModels({ isOpen: true, onClose })
  return (
    <DetailPanel title={t`Add Model`} onClose={state.onCancel} bodyLayout="fill">
      <AddProviderModels {...state} />
    </DetailPanel>
  )
}
