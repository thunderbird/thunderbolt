/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AlertTriangle, Cpu, Plus } from 'lucide-react'

import { SettingsEmptyState } from '@/components/settings/settings-empty-state'
import { SettingsListBody, SettingsSelectableRow } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { needsApiKey } from '@/components/ui/model-selector/model-selector'
import { PrivateBadge } from '@/components/ui/private-badge'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { Model } from '@/types'
import { getProviderDisplay, ModelProviderIconTile } from './model-presentation'

type ModelsListProps = {
  models: Model[]
  activeModelId: string | null
  onSelect: (modelId: string) => void
  onToggle: (modelId: string, enabled: boolean) => void
  onAdd: () => void
}

export const ModelsList = ({ models, activeModelId, onSelect, onToggle, onAdd }: ModelsListProps) => (
  <SettingsListBody className="gap-4">
    {models.map((model) => {
      const isEnabled = model.enabled === 1
      return (
        <SettingsSelectableRow
          key={model.id}
          onSelect={() => onSelect(model.id)}
          ariaLabel={`Open ${model.name}`}
          selected={activeModelId === model.id}
          leading={<ModelProviderIconTile model={model} />}
          title={
            <span className="flex min-w-0 items-center gap-2">
              {needsApiKey(model) && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p>API key not configured</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <span className="truncate">{model.name}</span>
              {!!model.isConfidential && <PrivateBadge />}
            </span>
          }
          subtitle={getProviderDisplay(model)}
          trailing={
            <Switch
              checked={isEnabled}
              onCheckedChange={(checked) => onToggle(model.id, checked)}
              className="cursor-pointer"
              aria-label={isEnabled ? `Disable ${model.name}` : `Enable ${model.name}`}
            />
          }
        />
      )
    })}
    {models.length === 0 && (
      <SettingsEmptyState
        icon={<Cpu className="size-10 text-muted-foreground" />}
        title="No models configured"
        description="Get started by adding your first AI model."
        action={
          <Button onClick={onAdd} variant="outline">
            <Plus className="mr-2 size-4" />
            Add Model
          </Button>
        }
      />
    )}
  </SettingsListBody>
)
