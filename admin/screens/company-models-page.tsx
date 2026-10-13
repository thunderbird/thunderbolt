/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Trash2 } from 'lucide-react'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { SettingsListPane } from '@/components/settings/settings-list'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { PageHeader } from '@/components/ui/page-header'
import { ModelsList } from '@/settings/models/models-list'
import { ModelProviderIconTile, getProviderDisplay } from '@/settings/models/model-presentation'
import { PreviewResetAction } from '../preview-reset-action'
import type { AdminPreview } from '../use-admin-preview-state'
import { CompanyModelPolicy } from './company-model-policy'
import { CompanyModelEditor } from './company-model-editor'
import { ResourcePageDialogs } from './resource-page-dialogs'
import { useResourcePageState } from './use-resource-page-state'

export const CompanyModelsPage = ({ preview }: { preview: AdminPreview }) => {
  const { i18n, t } = useLingui()
  const page = useResourcePageState()
  const model = preview.companyModels.find((item) => item.id === page.selectedId)
  const open = page.selectedId === 'new' || !!model
  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane className="gap-6 md:pb-12">
          <PageHeader title={t`Models`}>
            <PreviewResetAction
              onReset={() => {
                preview.dispatch({ type: 'reset' })
                page.select(null)
              }}
            />
            <CompanyModelPolicy preview={preview} />
            <PageCreateAction label={t`New Model`} onClick={() => page.requestSelect('new')} />
          </PageHeader>
          <ModelsList
            models={preview.companyModels.map((item) => ({ ...item, isSystem: 0, isConfidential: 0, apiKey: null }))}
            activeModelId={model?.id ?? null}
            onSelect={page.requestSelect}
            onAdd={() => page.requestSelect('new')}
            onToggle={(id, enabled) => {
              const item = preview.companyModels.find((row) => row.id === id)
              if (item) {
                preview.dispatch({ type: 'save-model', model: { ...item, enabled: enabled ? 1 : 0 } })
              }
            }}
            intro={
              <>
                <p className="text-sm text-muted-foreground">
                  <Trans>Models for the company's Thunderbolt agent.</Trans>
                </p>
              </>
            }
          />
        </SettingsListPane>
      </div>
      <DetailPanelSurface open={open} onClose={page.close}>
        {open && (
          <DetailPanel
            title={model ? t`Edit Model` : t`Add Model`}
            onClose={page.close}
            subtitle={model ? getProviderDisplay(i18n, { ...model, isSystem: 0 }) : t`Thunderbolt agent`}
            icon={model && <ModelProviderIconTile model={{ ...model, isSystem: 0 }} />}
            actions={
              model && (
                <DetailActionsMenu>
                  <DropdownMenuItem onClick={() => page.patch({ removeId: model.id })}>
                    <Trash2 />
                    <Trans>Remove model</Trans>
                  </DropdownMenuItem>
                </DetailActionsMenu>
              )
            }
          >
            <CompanyModelEditor
              key={page.selectedId}
              model={model}
              preview={preview}
              onClose={page.close}
              onSaved={() => page.select(null)}
              onDirtyChange={(dirty) => page.patch({ dirty })}
            />
          </DetailPanel>
        )}
      </DetailPanelSurface>
      <ResourcePageDialogs
        page={page}
        onRemove={(id) => preview.dispatch({ type: 'remove', kind: 'companyModels', id, at: Date.now() })}
      />
    </div>
  )
}
