/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState, useTransition } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { invoke } from '@tauri-apps/api/core'
import { Plus, Server, Trash2 } from 'lucide-react'
import { sshConnection, useSshEnvironmentsStore, type SshEnvironment } from '@/agent-execution/ssh-environments'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { SettingsListBody, SettingsListPane } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { ConfirmActionDialog } from '@/components/ui/confirm-action-dialog'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { PageCreateAction } from '@/components/ui/page-create-action'
import { isTauriDesktop } from '@/lib/platform'
import { SshEnvironmentForm } from './ssh-environment-form'
import { SshEnvironmentRow } from './ssh-environment-row'
import { SshDiscoveryDialog } from './ssh-discovery-dialog'

const EnvironmentsSettingsPage = () => {
  const { t } = useLingui()
  const environments = useSshEnvironmentsStore((state) => state.environments)
  const [{ panel, error }, setPanel] = useState<{ panel: string | null; error: string | null }>({
    panel: null,
    error: null,
  })
  const [pending, startTransition] = useTransition()
  const [removal, setRemoval] = useState<SshEnvironment | null>(null)
  const desktop = isTauriDesktop()
  const active = panel ? environments[panel] : undefined
  const visible = Object.values(environments).filter((environment) => !environment.deletedAt)
  const close = () => {
    setPanel({ panel: null, error: null })
  }
  const remove = (environment: SshEnvironment) =>
    startTransition(async () => {
      try {
        if (environment.hasSecret || environment.authentication === 'password') {
          await invoke('agent_ssh_set_secret', { connection: sshConnection(environment), secret: null })
        }
        useSshEnvironmentsStore.getState().deleteEnvironment(environment.id)
        setPanel((current) => (current.panel === environment.id ? { panel: null, error: null } : current))
      } catch {
        setPanel((current) =>
          current.panel === environment.id
            ? { ...current, error: t`Could not remove this SSH environment. Please try again.` }
            : current,
        )
      }
    })
  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane className="gap-6">
          <PageHeader title={t`Environments`}>
            {desktop && visible.length > 0 && (
              <PageCreateAction
                label={t`Add SSH environment`}
                onClick={() => {
                  setPanel({ panel: 'discover', error: null })
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
                  <Button variant="outline" onClick={() => setPanel({ panel: 'discover', error: null })}>
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
                    setPanel({ panel: environment.id, error: null })
                  }}
                />
              ))
            )}
          </SettingsListBody>
        </SettingsListPane>
      </div>
      {desktop && panel === 'discover' && (
        <SshDiscoveryDialog onClose={close} onManual={() => setPanel({ panel: 'new', error: null })} />
      )}
      {desktop && panel !== 'discover' && (
        <DetailPanelSurface open={panel !== null} onClose={close}>
          {panel !== null && (
            <DetailPanel
              title={active ? t`Edit SSH environment` : t`Add SSH environment`}
              onClose={close}
              actions={
                active && (
                  <DetailActionsMenu>
                    <DropdownMenuItem disabled={pending} onClick={() => setRemoval(active)}>
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
          onCancel={() => setRemoval(null)}
          onConfirm={() => {
            setRemoval(null)
            remove(removal)
          }}
        />
      )}
    </div>
  )
}

export default EnvironmentsSettingsPage
