/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { X } from 'lucide-react'
import { useState } from 'react'
import { useAppName } from '@/lib/branding-selectors'
import { PageSearch } from '@/components/ui/page-search'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { getProviderDisplay } from './model-presentation'

import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { SettingsListPane } from '@/components/settings/settings-list'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { PageHeader } from '@/components/ui/page-header'
import { StatusCard } from '@/components/ui/status-card'
import { useEntityActionIntent } from '@/search/actions/use-entity-action-intent'
import { AddProviderModelsPanel } from './add-provider-models-panel'
import { EditModelForm } from './edit-model-form'
import { ModelDetail } from './model-detail'
import { ModelsList } from './models-list'
import { useModelsPageState } from './use-models-page-state'

const ModelsPage = () => {
  const { t, i18n } = useLingui()
  const appName = useAppName()
  const [search, setSearch] = useState('')
  const page = useModelsPageState()
  const { activeModel, editingModel } = page
  const query = search.trim().toLowerCase()
  const filteredModels = page.models.filter((model) =>
    `${model.name} ${model.model} ${getProviderDisplay(i18n, model, appName)}`.toLowerCase().includes(query),
  )

  // Palette (Cmd+K) create/edit/remove intents arrive as one-shot router
  // state and route straight into the page's existing handlers (THU-768).
  useEntityActionIntent('model', {
    onCreate: page.openAddPanel,
    onEdit: (id) => page.openEditPanel(id),
    onRemove: (id) => page.requestDelete(id),
  })

  // Mutation errors surface where the mutation was triggered — the delete
  // dialog, add form, and edit form each render `mutationError` themselves, so
  // the page-level card shows only when none of those surfaces is open.
  const showPageLevelError = Boolean(
    page.mutationError && !page.deleteConfirmId && !page.isAddPanelOpen && !editingModel,
  )

  const renderPanel = () => {
    if (page.isAddPanelOpen) {
      return <AddProviderModelsPanel onClose={page.closePanel} />
    }
    if (activeModel && editingModel) {
      return (
        <DetailPanel
          title={t`Edit Model`}
          subtitle={editingModel.name}
          onClose={() => page.closeEditPanel(editingModel.id)}
        >
          <EditModelForm
            key={editingModel.id}
            model={editingModel}
            onCancel={() => page.closeEditPanel(editingModel.id)}
            onSubmit={page.submitEdit}
            isPending={page.isEditPending}
            submitError={page.mutationError}
          />
        </DetailPanel>
      )
    }
    if (activeModel) {
      return (
        <ModelDetail
          model={activeModel}
          onEdit={() => page.openEditPanel(activeModel.id)}
          onDelete={() => page.requestDelete(activeModel.id)}
          onReset={() => page.resetModel(activeModel.id)}
          onClose={page.closePanel}
        />
      )
    }
    return null
  }

  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane className="gap-6 md:pb-12">
          <PageSearch onSearch={setSearch}>
            <PageHeader title={t`Models`}>
              <PageSearch.Button />
              <PageCreateAction label={t`New Model`} onClick={page.openAddPanel} />
            </PageHeader>
            <PageSearch.Input placeholder={t`Search models`} onSearch={setSearch} />
          </PageSearch>
          {showPageLevelError && (
            <StatusCard
              icon={<X className="h-4 w-4 text-destructive" />}
              title={t`Something went wrong`}
              description={page.mutationError}
            />
          )}
          {query && filteredModels.length === 0 ? (
            <SettingsNoResults>
              <Trans>No matching models.</Trans>
            </SettingsNoResults>
          ) : (
            <ModelsList
              models={filteredModels}
              activeModelId={page.activeModelId}
              onSelect={page.selectActiveModel}
              onToggle={page.toggleModel}
              onAdd={page.openAddPanel}
              onEdit={page.openEditPanel}
              onRemove={page.requestDelete}
            />
          )}
        </SettingsListPane>
      </div>

      <DetailPanelSurface open={page.isAddPanelOpen || activeModel !== undefined} onClose={page.closePanel}>
        {renderPanel()}
      </DetailPanelSurface>

      <AlertDialog open={Boolean(page.deleteConfirmId)} onOpenChange={(open) => !open && page.requestDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Delete Model</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Delete this model from your configured models?</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {page.mutationError && <p className="text-sm text-destructive">{page.mutationError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={page.isDeletePending}>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction onClick={page.confirmDelete} disabled={page.isDeletePending} variant="destructive">
              {page.isDeletePending ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ModelsPage
