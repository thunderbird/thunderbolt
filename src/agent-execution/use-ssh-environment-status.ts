/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useLingui } from '@lingui/react/macro'
import { invokeSshRequest } from '@shared/agent-core/ssh-transport'
import { isTauriDesktop } from '@/lib/platform'
import { sshConnection, useSshEnvironmentsStore } from './ssh-environments'
import { createSshInvoke } from './ssh-invoke'

/** Automatically verify new/restored connections, sharing recent results without background authentication loops. */
export const useSshEnvironmentStatus = (id?: string) => {
  const { t } = useLingui()
  const environment = useSshEnvironmentsStore((state) => (id ? state.environments[id] : undefined))
  const savedStatus = useSshEnvironmentsStore((state) => (id ? state.connectionStatuses[id] : undefined))
  const connection = environment ? sshConnection(environment) : undefined
  const connectionKey = JSON.stringify(connection)
  const cached = savedStatus?.connectionKey === connectionKey ? savedStatus : undefined
  const desktop = isTauriDesktop()
  const available = desktop && Boolean(environment && !environment.deletedAt)
  const query = useQuery({
    queryKey: ['ssh-environment-status', connectionKey],
    enabled: available,
    initialData: cached,
    initialDataUpdatedAt: cached?.checkedAt,
    queryFn: async ({ signal }) => {
      if (!environment || environment.deletedAt || !connection || !desktop) {
        throw new Error('SSH environment is unavailable')
      }
      const observedStatus = useSshEnvironmentsStore.getState().connectionStatuses[environment.id]
      try {
        await invokeSshRequest<{ cwd: string; platform: string }>(
          createSshInvoke(connection, invoke),
          connection,
          { operation: 'probe', cwd: '~', owner: environment.id },
          signal,
        )
        return { connectionKey: connectionKey!, checkedAt: Date.now(), status: 'connected' as const }
      } catch (error) {
        if (!signal.aborted) {
          useSshEnvironmentsStore.getState().recordConnectionStatus(connection, 'disconnected', observedStatus)
        }
        throw error
      }
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  })
  const status = !available
    ? 'unavailable'
    : cached?.status === 'connected'
      ? 'connected'
      : query.isFetching
        ? 'checking'
        : (cached?.status ?? 'unchecked')
  const error = !desktop
    ? t`SSH environments require the desktop app.`
    : !environment || environment.deletedAt
      ? t`This SSH environment is unavailable on this computer.`
      : status === 'disconnected' && query.error
        ? String(query.error)
        : null
  return {
    status,
    error,
    refresh: () => {
      if (available && !query.isFetching) {
        void query.refetch({ cancelRefetch: false })
      }
    },
  } as const
}
