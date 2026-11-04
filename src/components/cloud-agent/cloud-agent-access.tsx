/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trans } from '@lingui/react/macro'
import { needsSyncSetupWizard } from '@/db/encryption'
import { getPrimaryKeyId } from '@/crypto/key-storage'
import { setSyncEnabled, syncEnabledChangeEvent } from '@/db/powersync/sync-state'
import { SyncSetupModal } from '@/components/sync-setup/sync-setup-modal'
import { SettingsListPane } from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { CloudError } from './common'

/** Read enrollment without gating local agents or other offline library entries. */
export const useCloudAgentReadiness = (ownerId: string, enabled = true) =>
  useQuery({
    queryKey: ['cloud-agent-encryption', ownerId],
    queryFn: async () => !(await needsSyncSetupWizard()) && !!(await getPrimaryKeyId()),
    networkMode: 'always',
    retry: false,
    enabled,
  })

/** Reuse account enrollment before mounting forms that need its encryption keys. */
export const CloudAgentAccess = ({ ownerId, children }: { ownerId: string; children: ReactNode }) => {
  const [setupOpen, setSetupOpen] = useState(false)
  const queryClient = useQueryClient()
  const readiness = useCloudAgentReadiness(ownerId)
  const complete = useMutation({
    mutationFn: async () => {
      await setSyncEnabled(true)
      await queryClient.invalidateQueries({ queryKey: ['cloud-agent-encryption', ownerId] })
      setSetupOpen(false)
    },
    networkMode: 'always',
  })
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: ['cloud-agent-encryption', ownerId] })
    }
    window.addEventListener(syncEnabledChangeEvent, refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener(syncEnabledChangeEvent, refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [queryClient, ownerId])
  if (readiness.data === true) {
    return children
  }
  return (
    <SettingsListPane>
      <div className="flex flex-col items-start gap-4 py-8">
        <CloudError error={readiness.error ?? complete.error} />
        {readiness.isPending ? (
          <p>
            <Trans>Checking account encryption…</Trans>
          </p>
        ) : (
          <>
            <p>
              <Trans>Set up encrypted sync on this device to create and use saved agents.</Trans>
            </p>
            <Button onClick={() => setSetupOpen(true)}>
              <Trans>Set up encrypted sync</Trans>
            </Button>
          </>
        )}
      </div>
      <SyncSetupModal open={setupOpen} onOpenChange={setSetupOpen} onComplete={() => complete.mutate()} />
    </SettingsListPane>
  )
}
