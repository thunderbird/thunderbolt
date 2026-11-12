/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Plus, Server, Trash2 } from 'lucide-react'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { SettingsListBody, SettingsListPane } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { SshEnvironmentForm } from './ssh-environment-form'
import { SshEnvironmentRow } from './ssh-environment-row'
import { SshDiscoveryDialog } from './ssh-discovery-dialog'
import { useEnvironmentsSettingsState } from './use-environments-settings-state'

const EnvironmentsSettingsPage = () => {
  const { t } = useLingui()
  const {
    panel,
    error,
    pending,
    removal,
    active,
    visible,
    desktop,
    open,
    close,
    requestRemoval,
    cancelRemoval,
    confirmRemoval,
  } = useEnvironmentsSettingsState()
  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane className="gap-6">
          <PageHeader title={t`Environments`}>
            {desktop && visible.length > 0 && (
              <PageCreateAction
                label={t`Add SSH environment`}
                onClick={() => {
                  open('discover')
                }}
              />
            )}
          </PageHeader>
          <SettingsListBody>
            {!desktop ? (
              <EmptyState
                icon={Server}
                title={t`SSH requires the desktop app`}
                description={t`Configure SSH environments in Thunderbolt for macOS, Windows, or Linux.`}
              />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={Server}
                title={t`No SSH environments`}
                action={
                  <Button variant="outline" onClick={() => open('discover')}>
                    <Plus />
                    <Trans>Add SSH environment</Trans>
                  </Button>
                }
              />
            ) : (
              visible.map((environment) => (
                <SshEnvironmentRow
                  key={environment.id}
                  environment={environment}
                  selected={panel === environment.id}
                  onSelect={() => {
                    open(environment.id)
                  }}
                />
              ))
            )}
          </SettingsListBody>
        </SettingsListPane>
      </div>
      {desktop && panel === 'discover' && <SshDiscoveryDialog onClose={close} onManual={() => open('new')} />}
      {desktop && panel !== 'discover' && (
        <DetailPanelSurface open={panel !== null} onClose={close}>
          {panel !== null && (
            <DetailPanel
              title={active ? t`Edit SSH environment` : t`Add SSH environment`}
              onClose={close}
              actions={
                active && (
                  <DetailActionsMenu>
                    <DropdownMenuItem disabled={pending} onClick={() => requestRemoval(active)}>
                      <Trash2 />
                      <Trans>Remove SSH environment</Trans>
                    </DropdownMenuItem>
                  </DetailActionsMenu>
                )
              }
            >
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <SshEnvironmentForm key={panel} environment={active} onSaved={close} onCancel={close} />
            </DetailPanel>
          )}
        </DetailPanelSurface>
      )}
      {removal && (
        <ConfirmActionDialog
          open
          title={t`Remove ${removal.name}?`}
          description={t`Projects using this environment will no longer be able to run. Their files and chat history will be kept.`}
          confirmLabel={t`Remove SSH environment`}
          onCancel={cancelRemoval}
          onConfirm={confirmRemoval}
        />
      )}
    </div>
  )
}

export default EnvironmentsSettingsPage
