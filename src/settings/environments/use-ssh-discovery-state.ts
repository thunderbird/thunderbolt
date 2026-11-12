/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'

export type DiscoveredSshHost = {
  id: string
  name: string
  source: 'SSH config' | 'OrbStack' | 'Tart' | 'Docker'
  host: string | null
  username: string | null
  port: number | null
}

/** Discover local inventories without starting machines; saved profiles share the automatic connection check. */
export const useSshDiscoveryState = (onAdded: () => void) => {
  const environments = useSshEnvironmentsStore((state) => state.environments)
  const query = useQuery({
    queryKey: ['ssh-discovery'],
    queryFn: () => invoke<DiscoveredSshHost[]>('agent_ssh_discover'),
    retry: false,
    gcTime: 0,
  })
  const [selected, setSelected] = useState<string[]>([])
  const options = (query.data ?? []).filter(
    (option) =>
      !Object.values(environments).some(
        (environment) =>
          !environment.deletedAt &&
          environment.host === option.host &&
          (environment.username ?? null) === option.username &&
          (environment.port ?? null) === option.port,
      ),
  )
  const choices = options.filter((option) => option.host && selected.includes(option.id))
  return {
    options,
    selected,
    loading: query.isFetching,
    error: query.error,
    refresh: () => {
      if (!query.isFetching) {
        void query.refetch({ cancelRefetch: false })
      }
    },
    toggle: (id: string) =>
      setSelected((previous) => (previous.includes(id) ? previous.filter((value) => value !== id) : [...previous, id])),
    canAdd: choices.length > 0,
    add: () => {
      if (!choices.length) {
        return
      }
      for (const option of choices) {
        useSshEnvironmentsStore.getState().saveEnvironment({
          id: crypto.randomUUID(),
          name: option.name.slice(0, 100),
          host: option.host!,
          username: option.username ?? undefined,
          port: option.port ?? undefined,
          authentication: 'agent',
          cwd: '~',
          deletedAt: null,
        })
      }
      onAdded()
    },
  }
}
