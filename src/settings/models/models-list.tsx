/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { AlertTriangle, Cpu, Plus } from 'lucide-react'

import { SettingsEmptyState } from '@/components/settings/settings-empty-state'
import { SettingsListBody, settingsListBodyRowsClass, SettingsSelectableRow } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { needsApiKey } from './model-policy'
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

/** Presentational list of configured models with enable toggles and the add affordance. */
export const ModelsList = ({ models, activeModelId, onSelect, onToggle, onAdd }: ModelsListProps) => {
  const { i18n, t } = useLingui()

  return (
    <SettingsListBody className={settingsListBodyRowsClass}>
      {models.map((model) => {
        const isEnabled = model.enabled === 1
        const modelName = model.name
        return (
          <SettingsSelectableRow
            key={model.id}
            onSelect={() => onSelect(model.id)}
            ariaLabel={t`Open ${modelName}`}
            isSelected={activeModelId === model.id}
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
                        <p>
                          <Trans>API key not configured</Trans>
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
                <span className="truncate">{model.name}</span>
                {!!model.isConfidential && <PrivateBadge />}
              </span>
            }
            subtitle={getProviderDisplay(i18n, model)}
            trailing={
              <Switch
                checked={isEnabled}
                onCheckedChange={(checked) => onToggle(model.id, checked)}
                className="cursor-pointer"
                aria-label={isEnabled ? t`Disable ${modelName}` : t`Enable ${modelName}`}
              />
            }
          />
        )
      })}
      {models.length === 0 && (
        <SettingsEmptyState
          icon={<Cpu className="size-10 text-muted-foreground" />}
          title={t`No models configured`}
          description={t`Get started by adding your first AI model.`}
          action={
            <Button onClick={onAdd} variant="outline">
              <Plus className="mr-2 size-4" />
              <Trans>Add Model</Trans>
            </Button>
          }
        />
      )}
    </SettingsListBody>
  )
}
