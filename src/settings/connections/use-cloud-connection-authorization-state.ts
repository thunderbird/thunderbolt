/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useReducer } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { CloudConnectionConfig } from '@shared/cloud-agent/contracts'
import type { CloudAgentClient, CloudConnectionView } from '@/cloud-agent/client'
import { cloudConfigFromLibrary, type CloudLibrarySource } from '@/cloud-agent/connection-library'
import { usePreparedSave } from '@/components/cloud-agent/use-prepared-save'
import { openExternalUrl } from '@/lib/open-external-url'

export type CloudConnectionAuthorizationProps = {
  client: CloudAgentClient
  connection?: CloudConnectionView
  source: CloudLibrarySource
  refresh: () => Promise<unknown>
  available: boolean
  bindToLibrary?: boolean
}

/** Keep grants and prepared saves separate from presentation and device-local authentication. */
export const useCloudConnectionAuthorizationState = ({
  client,
  connection,
  source,
  refresh,
  bindToLibrary = true,
}: CloudConnectionAuthorizationProps) => {
  const [draft, patch] = useReducer(
    (value: CloudConnectionConfig, next: Partial<CloudConnectionConfig>) => ({ ...value, ...next }),
    {
      ...cloudConfigFromLibrary(source, connection?.config),
      ...(!bindToLibrary ? { libraryRef: connection?.config.libraryRef } : {}),
    },
  )
  const changedEndpoint = !!connection && connection.config.url !== source.url
  const save = usePreparedSave({
    prepare: () =>
      client.prepareConnection({ ...draft, name: source.name }, connection?.record, connection?.record.enabled ?? true),
    submit: client.submitConnection,
    onSuccess: () => {
      void refresh()
    },
  })
  const toggle = useMutation({
    mutationFn: () => client.saveConnection(connection!.config, connection!.record, !connection!.record.enabled),
    onSuccess: refresh,
    retry: false,
    networkMode: 'always',
  })
  const test = useMutation({
    mutationFn: () => client.testConnection(connection!.record.id),
    onSuccess: refresh,
    retry: false,
    networkMode: 'always',
  })
  const oauth = useMutation({
    mutationFn: () => client.startConnectionOAuth(connection!.record.id),
    onSuccess: async (result) => openExternalUrl(result.authorizationUrl),
    retry: false,
    networkMode: 'always',
  })
  const busy = save.isPending || toggle.isPending || oauth.isPending || test.isPending
  const limits = draft.modelLimits
  const limit = (field: keyof NonNullable<CloudConnectionConfig['modelLimits']>, value: string) => {
    if (limits) {
      patch({ modelLimits: { ...limits, [field]: Number(value) } })
    }
  }
  return { draft, patch, changedEndpoint, save, toggle, test, oauth, busy, limits, limit }
}
