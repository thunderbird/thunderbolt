/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Plus, X } from 'lucide-react'

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
import { StatusCard } from '@/components/ui/status-card'
import { AddModelForm } from './add-model-form'
import { EditModelForm } from './edit-model-form'
import { ModelDetail } from './model-detail'
import { ModelsList } from './models-list'
import { useModelsPageState } from './use-models-page-state'

const ModelsPage = () => {
  const page = useModelsPageState()
  const { activeModel, editingModel } = page

  const renderPanel = () => {
    if (page.isAddPanelOpen) {
      return (
        <DetailPanel title="Add Model" onClose={page.addForm.onCancel}>
          <AddModelForm {...page.addForm} />
        </DetailPanel>
      )
    }
    if (activeModel && editingModel) {
      return (
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
          {page.mutationError && !page.deleteConfirmId && !page.isAddPanelOpen && !editingModel && (
            <StatusCard
              icon={<X className="h-4 w-4 text-destructive" />}
              title="Something went wrong"
              description={page.mutationError}
            />
          )}
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
        {renderPanel()}
      </DetailPanelSurface>

      <AlertDialog open={Boolean(page.deleteConfirmId)} onOpenChange={(open) => !open && page.requestDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Model</AlertDialogTitle>
            <AlertDialogDescription>Delete this model from your configured models?</AlertDialogDescription>
          </AlertDialogHeader>
          {page.mutationError && <p className="text-sm text-destructive">{page.mutationError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={page.isDeletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={page.confirmDelete} disabled={page.isDeletePending} variant="destructive">
              {page.isDeletePending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default ModelsPage
