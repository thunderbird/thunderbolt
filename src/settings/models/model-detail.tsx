/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AlertTriangle } from 'lucide-react'

import { DetailDivider, DetailPanel } from '@/components/detail-panel'
import { ModificationIndicator } from '@/components/modification-indicator'
import { DetailActionsMenu, DetailEditDeleteMenuItems } from '@/components/settings/detail-actions-menu'
import { DetailField } from '@/components/settings/detail-field'
import { needsApiKey } from '@/components/ui/model-selector/model-selector'
import { PrivateBadge } from '@/components/ui/private-badge'
import { isModelModified } from '@/defaults/utils'
import type { Model } from '@/types'
import { getProviderDisplay, ModelProviderIconTile } from './model-presentation'

export const systemModelMenuMessage = "Built-in models can't be edited or removed"

type ModelDetailProps = {
  model: Model
  onEdit: () => void
  onDelete: () => void
  onReset: () => void
  onClose: () => void
}

export const ModelDetail = ({ model, onEdit, onDelete, onReset, onClose }: ModelDetailProps) => (
  <DetailPanel
    icon={<ModelProviderIconTile model={model} />}
    title={model.name}
    subtitle={getProviderDisplay(model)}
    actions={
      <DetailActionsMenu>
        {model.isSystem === 1 ? (
          <div className="px-2 py-1.5 text-[length:var(--font-size-sm)] text-muted-foreground">
            {systemModelMenuMessage}
          </div>
        ) : (
          <DetailEditDeleteMenuItems onEdit={onEdit} onDelete={onDelete} />
        )}
      </DetailActionsMenu>
    }
    onClose={onClose}
  >
    <div className="flex flex-col gap-4">
      <DetailField label="Model">
        <p className="truncate text-base text-foreground">{model.model}</p>
      </DetailField>
      {model.url && (
        <DetailField label="URL">
          <p className="truncate text-base text-foreground">{model.url}</p>
        </DetailField>
      )}
      {!!model.isConfidential && (
        <DetailField label="Privacy">
          <div>
            <PrivateBadge />
          </div>
        </DetailField>
      )}
    </div>

    {needsApiKey(model) && (
      <>
        <DetailDivider />
        <div className="flex items-center gap-2 text-sm text-amber-600">
          <AlertTriangle className="size-4 shrink-0" />
          API key not configured
        </div>
      </>
    )}

    {isModelModified(model) && (
      <>
        <DetailDivider />
        <ModificationIndicator
          hasModifications
          onReset={onReset}
          customMessage="You've customized this model."
          ariaLabel="Modified model"
          requireConfirmation={false}
        >
          Customized model
        </ModificationIndicator>
      </>
    )}
  </DetailPanel>
)
