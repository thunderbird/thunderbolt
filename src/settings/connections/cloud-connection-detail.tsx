/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { Trans } from '@lingui/react/macro'
import { useDatabase } from '@/contexts'
import { DetailPanel } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CloudError, CloudField } from '@/components/cloud-agent/common'
import { usePreparedSave } from '@/components/cloud-agent/use-prepared-save'
import { cloudConfigFromLibrary, getCloudMcpBinding, type CloudLibrarySource } from '@/cloud-agent/connection-library'
import { useCloudAgentLibrary } from '@/cloud-agent/use-cloud-agent-library'
import { modelCloudEndpoint } from '@/cloud-agent/library'
import type { CloudAgentClient, CloudConnectionView } from '@/cloud-agent/client'
import type { McpServer } from '@/types'
import { CloudConnectionAuthorization } from './cloud-connection-authorization'
import { importCloudMcpDefinition } from './import-cloud-connection'

/** Keep older and other-device authorizations discoverable until explicitly linked to this device's library. */
export const CloudConnectionDetail = ({
  client,
  connection,
  servers,
  available,
  refresh,
  onClose,
}: {
  client: CloudAgentClient
  connection: CloudConnectionView
  servers: McpServer[]
  available: boolean
  refresh: () => Promise<unknown>
  onClose: () => void
}) => {
  const db = useDatabase()
  const library = useCloudAgentLibrary()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const sources: CloudLibrarySource[] =
    connection.config.kind === 'mcp'
      ? servers
          .map((server) => getCloudMcpBinding(server, []))
          .filter((entry) => entry.eligible)
          .map((entry) => entry.source)
      : library.models.flatMap((model) => {
          const url = modelCloudEndpoint(model)
          return url
            ? [
                {
                  kind: 'model' as const,
                  id: model.id,
                  name: model.name,
                  url,
                  contextWindow: model.contextWindow ?? undefined,
                },
              ]
            : []
        })
  const selected = sources.find((source) => source.id === selectedId)
  const importDefinition = usePreparedSave({
    prepare: async () => {
      const source = await importCloudMcpDefinition(db, connection)
      return client.prepareConnection(
        cloudConfigFromLibrary(source, connection.config),
        connection.record,
        connection.record.enabled,
      )
    },
    submit: client.submitConnection,
    onSuccess: () => {
      void refresh()
    },
  })
  const source = selected ?? {
    kind: connection.config.kind,
    id: connection.config.libraryRef?.id ?? connection.record.id,
    name: connection.config.name,
    url: connection.config.url,
  }
  return (
    <DetailPanel title={connection.config.name} subtitle={connection.config.url} onClose={onClose}>
      <p className="text-sm text-muted-foreground">
        <Trans>
          This cloud authorization is not linked to a connection in this device’s library. Link its definition to select
          it in an agent.
        </Trans>
      </p>
      {sources.length > 0 && (
        <CloudField label={<Trans>Library connection</Trans>}>
          <Select value={selectedId ?? ''} onValueChange={setSelectedId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="" />
            </SelectTrigger>
            <SelectContent>
              {sources.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CloudField>
      )}
      {connection.config.kind === 'mcp' && (
        <Button
          variant="outline"
          disabled={!available || importDefinition.isPending}
          onClick={() => importDefinition.mutate()}
        >
          {importDefinition.hasPrepared ? (
            <Trans>Retry linking definition</Trans>
          ) : (
            <Trans>Add definition to this device</Trans>
          )}
        </Button>
      )}
      <CloudError error={importDefinition.error} />
      <CloudConnectionAuthorization
        key={`${source.id}:${source.url}:${connection.record.version}`}
        source={source}
        connection={connection}
        client={client}
        refresh={refresh}
        available={available}
        bindToLibrary={!!selected || !!connection.config.libraryRef}
      />
    </DetailPanel>
  )
}
