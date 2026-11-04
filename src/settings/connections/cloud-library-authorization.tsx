/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { CloudAgentAccess } from '@/components/cloud-agent/cloud-agent-access'
import { CloudError } from '@/components/cloud-agent/common'
import { DetailDivider, DetailSectionTitle } from '@/components/detail-panel'
import { cloudLibraryBindings, type CloudLibrarySource } from '@/cloud-agent/connection-library'
import { CloudConnectionAuthorization } from './cloud-connection-authorization'
import { useCloudConnectionLibrary } from './use-cloud-connection-library'

/** Add environment authorization to an existing library aside without introducing another catalog. */
export const CloudLibraryAuthorization = ({ source }: { source: CloudLibrarySource }) => {
  const state = useCloudConnectionLibrary()
  const matches = cloudLibraryBindings(source, state.connections.data ?? [])
  return (
    <>
      <DetailDivider />
      <DetailSectionTitle>
        <Trans>Cloud authorization</Trans>
      </DetailSectionTitle>
      {!state.ownerId || !state.client ? (
        <p className="text-sm text-muted-foreground">
          <Trans>Sign in to authorize this connection for cloud agents.</Trans>
        </p>
      ) : (
        <CloudAgentAccess ownerId={state.ownerId}>
          <CloudError error={state.capabilities.error ?? state.connections.error} />
          {state.capabilities.data &&
            (matches.length > 0 ? matches : [undefined]).map((connection) => (
              <CloudConnectionAuthorization
                key={`${connection?.record.id ?? 'new'}:${connection?.record.version ?? 0}:${source.url}`}
                source={source}
                connection={connection}
                client={state.client!}
                refresh={state.refresh}
                available={state.available}
              />
            ))}
        </CloudAgentAccess>
      )}
    </>
  )
}
