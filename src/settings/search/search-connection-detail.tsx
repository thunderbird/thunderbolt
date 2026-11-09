/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Settings2 } from 'lucide-react'
import { Link } from 'react-router'
import { DetailPanel } from '@/components/detail-panel'
import { DetailActionsMenu } from '@/components/settings/detail-actions-menu'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ProviderConnectionIcon } from '@/settings/connections/provider-connection-icon'
import { ProviderConnectionSummary } from '@/settings/connections/provider-connection-summary'
import { ModelProviderIconTile } from '@/settings/models/model-presentation'
import { canSupplySearch } from '@/integrations/standalone-search/eligibility'
import type { ProviderConnection } from '@/providers/types'

/** Present search with the same saved-connection identity and header actions as other settings. */
export const SearchConnectionDetail = ({
  connection,
  searchAvailable,
  onClose,
}: {
  connection?: ProviderConnection
  searchAvailable: boolean
  onClose: () => void
}) => {
  return (
    <DetailPanel
      title={connection?.name ?? 'Thunderbolt'}
      icon={
        connection ? (
          <ProviderConnectionIcon provider={connection.provider} />
        ) : (
          <ModelProviderIconTile model={{ provider: 'thunderbolt', isSystem: 1 }} />
        )
      }
      actions={
        <DetailActionsMenu>
          <DropdownMenuItem asChild>
            <Link to="/settings/connections" state={connection ? { providerConnectionId: connection.id } : undefined}>
              <Settings2 />
              <Trans>Manage connection</Trans>
            </Link>
          </DropdownMenuItem>
        </DetailActionsMenu>
      }
      onClose={onClose}
    >
      {connection ? (
        <ProviderConnectionSummary connection={connection}>
          {!canSupplySearch(connection) ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Connect or enable this connection to use search</Trans>
            </p>
          ) : connection.provider === 'otari' && !searchAvailable ? (
            <p className="text-sm text-muted-foreground">
              <Trans>Otari web search isn’t available. Configure a search provider in Otari to use it here.</Trans>
            </p>
          ) : connection.provider === 'tinfoil' ? (
            <p className="text-sm text-muted-foreground">
              <Trans>
                Exa provides search and page content through Tinfoil’s encrypted connection and privacy filters. No
                separate Exa API key is needed.
              </Trans>
            </p>
          ) : null}
        </ProviderConnectionSummary>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans>Search and page content are provided by your connected Thunderbolt server.</Trans>
        </p>
      )}
    </DetailPanel>
  )
}
