/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { invokeSshRequest, type SshDirectoryListing } from '@shared/agent-core/ssh-transport'
import { sshConnection, useSshEnvironmentsStore } from '@/agent-execution/ssh-environments'
import { createSshInvoke } from '@/agent-execution/ssh-invoke'
import { isTauriDesktop } from '@/lib/platform'

/** Read one remote directory at a time, only while the user has opened the folder picker. */
export const useSshFolderPickerState = (environmentId: string, initialPath: string) => {
  const [{ path, filter }, setLocation] = useState({ path: initialPath || '~', filter: '' })
  const environment = useSshEnvironmentsStore((state) => state.environments[environmentId])
  const connection = environment && !environment.deletedAt ? sshConnection(environment) : undefined
  const available = isTauriDesktop() && Boolean(connection)
  const query = useQuery({
    queryKey: ['ssh-directories', connection, path],
    enabled: available,
    queryFn: ({ signal }) => {
      if (!connection) {
        throw new Error('SSH environment unavailable')
      }
      return invokeSshRequest<SshDirectoryListing>(
        createSshInvoke(connection, invoke),
        connection,
        { operation: 'list_directories', cwd: path, owner: environmentId },
        signal,
      )
    },
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: 15_000,
    gcTime: 0,
  })
  const term = filter.toLocaleLowerCase()
  return {
    available,
    path: query.data?.path ?? path,
    parentPath: query.data?.parentPath,
    filter,
    directories: (query.data?.directories ?? []).filter((directory) =>
      directory.name.toLocaleLowerCase().includes(term),
    ),
    loading: query.isFetching,
    error: query.error,
    canSelect: available && Boolean(query.data) && !query.isFetching && !query.isError,
    navigate: (next: string) => setLocation({ path: next, filter: '' }),
    setFilter: (next: string) => setLocation((current) => ({ ...current, filter: next })),
    refresh: () => void query.refetch({ cancelRefetch: false }),
  }
}
