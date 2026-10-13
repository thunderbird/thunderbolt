/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans } from '@lingui/react/macro'
import { AddModelForm } from '@/settings/models/add-model-form'
import type { CompanyModel } from '../data'
import type { AdminPreview } from '../use-admin-preview-state'
import { useCompanyModelEditorState } from './use-company-model-editor-state'

export const CompanyModelEditor = ({
  model,
  preview,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  model?: CompanyModel
  preview: AdminPreview
  onClose: () => void
  onSaved: () => void
  onDirtyChange: (dirty: boolean) => void
}) => {
  const editor = useCompanyModelEditorState({ model, preview, onSaved, onDirtyChange })
  return (
    <div className="flex flex-1 flex-col" onChange={editor.changed}>
      <p className="text-sm text-muted-foreground">
        <Trans>
          Configuration is saved locally for this proposal. Provider connections and API keys aren't active yet.
        </Trans>
      </p>
      <AddModelForm
        {...editor}
        mode={model ? 'edit' : 'create'}
        connectionMode="configuration"
        isLoadingCatalog={false}
        catalogError={null}
        isPending={false}
        isTesting={false}
        connectionStatus="idle"
        connectionError={null}
        onCancel={onClose}
        onCatalogInvalidated={editor.changed}
        onTestConnection={() => {}}
      />
    </div>
  )
}
