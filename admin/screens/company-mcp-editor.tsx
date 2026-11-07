/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useReducer } from 'react'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { ResponsiveModalCancel } from '@/components/ui/responsive-modal'
import { validateMcpServerUrl } from '@/lib/mcp-url-validation'
import { McpServerAddressFields } from '@/settings/connections/mcp-server-address-fields'
import type { CompanyMcpServer } from '../data'
import type { AdminPreview } from '../use-admin-preview-state'

type Draft = Pick<CompanyMcpServer, 'name' | 'url' | 'transport'>
/** Keep connection edits in a draft until a valid local configuration is saved. */
const useCompanyMcpEditorState = (server: CompanyMcpServer | undefined, onDirtyChange: (dirty: boolean) => void) => {
  const initial: Draft = { name: server?.name ?? '', url: server?.url ?? '', transport: server?.transport ?? 'http' }
  const [draft, update] = useReducer((current: Draft, patch: Partial<Draft>) => ({ ...current, ...patch }), initial)
  const isDirty = (value: Draft) =>
    value.name !== initial.name || value.url !== initial.url || value.transport !== initial.transport
  const patch = (value: Partial<Draft>) => {
    onDirtyChange(isDirty({ ...draft, ...value }))
    update(value)
  }
  const validation = draft.url.trim() ? validateMcpServerUrl(draft.url.trim()) : null
  return { draft, patch, validation, canSave: !!draft.name.trim() && validation?.ok && (!server || isDirty(draft)) }
}

export const CompanyMcpEditor = ({
  server,
  preview,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  server?: CompanyMcpServer
  preview: AdminPreview
  onClose: () => void
  onSaved: () => void
  onDirtyChange: (dirty: boolean) => void
}) => {
  const { t } = useLingui()
  const { draft, patch, validation, canSave } = useCompanyMcpEditorState(server, onDirtyChange)
  return (
    <form
      className="flex flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault()
        if (!canSave) {
          return
        }
        preview.dispatch({
          type: 'save-mcp-server',
          server: {
            ...server,
            ...draft,
            id: server?.id ?? crypto.randomUUID(),
            name: draft.name.trim(),
            url: draft.url.trim(),
            enabled: server?.enabled ?? 1,
            deletedAt: null,
          },
        })
        onSaved()
      }}
    >
      <div className="grid grid-cols-1 gap-4">
        <McpServerAddressFields
          name={draft.name}
          url={draft.url}
          transport={draft.transport}
          onNameChange={(name) => patch({ name })}
          onUrlChange={(url) => patch({ url })}
          onTransportChange={(transport) => patch({ transport })}
          urlValidation={validation}
          autofocus={!server}
        />
        <p className="text-sm text-muted-foreground">
          <Trans>
            Configuration is saved locally for this proposal. Server connections and authentication aren't active yet.
          </Trans>
        </p>
      </div>
      <FormFooter>
        <ResponsiveModalCancel onClick={onClose} />
        <Button type="submit" disabled={!canSave}>
          {server ? t`Save Changes` : t`Add Server`}
        </Button>
      </FormFooter>
    </form>
  )
}
