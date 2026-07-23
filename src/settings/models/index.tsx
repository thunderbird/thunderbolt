/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus } from 'lucide-react'

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
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { AddModelForm } from './add-model-form'
import { EditModelForm } from './edit-model-form'
import { ModelDetail, systemModelMenuMessage } from './model-detail'
import { ModelsList } from './models-list'
import { useModelsPageState } from './use-models-page-state'

export { systemModelMenuMessage }

/** Determines whether the add-model form has completed every submission gate. */
export const shouldDisableAddModel = (
  isPending: boolean,
  isFormValid: boolean,
  requiresConnectionTest: boolean,
  isConnectionSuccessful: boolean,
) => isPending || !isFormValid || (requiresConnectionTest && !isConnectionSuccessful)

const ModelsPage = () => {
  const page = useModelsPageState()
  const { activeModel, editingModel } = page

  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane className="gap-6 pb-12">
          <PageHeader title="Models">
            <Button
              variant="outline"
              size="icon"
              className="bg-card"
              aria-label="Add model"
              onClick={page.openAddPanel}
            >
              <Plus />
            </Button>
          </PageHeader>
          <ModelsList
            models={page.models}
            activeModelId={page.activeModelId}
            onSelect={page.selectActiveModel}
            onToggle={page.toggleModel}
            onAdd={page.openAddPanel}
          />
        </SettingsListPane>
      </div>

      <DetailPanelSurface
        open={page.isAddPanelOpen || activeModel !== undefined}
        isMobile={page.isMobile}
        onClose={page.closePanel}
      >
        {page.isAddPanelOpen ? (
          <DetailPanel title="Add Model" onClose={page.addForm.onCancel}>
            <AddModelForm {...page.addForm} />
          </DetailPanel>
        ) : activeModel && editingModel ? (
          <DetailPanel
            title="Edit Model"
            subtitle={editingModel.name}
            onClose={() => page.closeEditPanel(editingModel.id)}
          >
            <EditModelForm
              key={editingModel.id}
              model={editingModel}
              onCancel={() => page.closeEditPanel(editingModel.id)}
              onSubmit={page.submitEdit}
              isPending={page.isEditPending}
            />
          </DetailPanel>
        ) : activeModel ? (
          <ModelDetail
            model={activeModel}
            onEdit={() => page.openEditPanel(activeModel.id)}
            onDelete={() => page.requestDelete(activeModel.id)}
            onReset={() => page.resetModel(activeModel.id)}
            onClose={page.closePanel}
          />
        ) : null}
      </DetailPanelSurface>

      <AlertDialog open={Boolean(page.deleteConfirmId)} onOpenChange={(open) => !open && page.requestDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Model</AlertDialogTitle>
            <AlertDialogDescription>Remove this model from your configured models?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={page.isDeletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={page.confirmDelete} disabled={page.isDeletePending} variant="destructive">
              {page.isDeletePending ? 'Removing…' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ModelsPage
