/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Trash2 } from 'lucide-react'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ConnectionsList } from '@/settings/connections/connections-list'
import { PreviewResetAction } from '../preview-reset-action'
import type { AdminPreview } from '../use-admin-preview-state'
import { CompanyMcpEditor } from './company-mcp-editor'
import { ResourcePageDialogs } from './resource-page-dialogs'
import { useResourcePageState } from './use-resource-page-state'

export const CompanyMcpPage = ({ preview }: { preview: AdminPreview }) => {
  const { t } = useLingui()
  const page = useResourcePageState()
  const server = preview.companyMcpServers.find((item) => item.id === page.selectedId)
  const open = page.selectedId === 'new' || !!server
  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <ConnectionsList
          integrations={[]}
          areIntegrationsReady
          servers={preview.companyMcpServers}
          serverStatus={() => 'neutral'}
          activeKey={server ? `server:${server.id}` : null}
          onAdd={() => page.requestSelect('new')}
          onSelectServer={page.requestSelect}
          onEditServer={page.requestSelect}
          onDeleteServer={(removeId) => page.patch({ removeId })}
          onToggleServer={(id, enabled) => {
            const item = preview.companyMcpServers.find((row) => row.id === id)
            if (item) {
              preview.dispatch({ type: 'save-mcp-server', server: { ...item, enabled: enabled ? 1 : 0 } })
            }
          }}
          onSelectIntegration={() => {}}
          onToggleIntegration={() => {}}
          actions={
            <PreviewResetAction
              onReset={() => {
                preview.dispatch({ type: 'reset' })
                page.select(null)
              }}
            />
          }
          intro={
            <>
              <p className="text-sm text-muted-foreground">
                <Trans>Connections for the company's Thunderbolt agent.</Trans>
              </p>
            </>
          }
        />
      </div>
      <DetailPanelSurface open={open} onClose={page.close}>
        {open && (
          <DetailPanel
            title={server ? t`Edit MCP Server` : t`Add MCP Server`}
            subtitle={t`Thunderbolt agent`}
            onClose={page.close}
            actions={
              server && (
                <DetailActionsMenu>
                  <DropdownMenuItem onClick={() => page.patch({ removeId: server.id })}>
                    <Trash2 />
                    <Trans>Remove server</Trans>
                  </DropdownMenuItem>
                </DetailActionsMenu>
              )
            }
          >
            <CompanyMcpEditor
              key={page.selectedId}
              server={server}
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
        onRemove={(id) => preview.dispatch({ type: 'remove', kind: 'companyMcpServers', id, at: Date.now() })}
      />
    </div>
  )
}
