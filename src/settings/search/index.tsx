/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Link } from 'react-router'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import {
  SettingsListBody,
  SettingsListPane,
  SettingsSelectableRow,
  settingsListBodyRowsClass,
} from '@/components/settings/settings-list'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { PrivateBadge } from '@/components/ui/private-badge'
import { Switch } from '@/components/ui/switch'
import { canSupplySearch } from '@/integrations/standalone-search/eligibility'
import { isSearchProvider } from '@/integrations/standalone-search/providers'
import { getProviderDefinition } from '@/providers/registry'
import { ModelProviderIconTile } from '@/settings/models/model-presentation'
import { SearchProviderIconTile } from './search-provider-icon-tile'
import { useSearchSettingsState } from './use-search-settings-state'

const SearchSettingsPage = () => {
  const { t } = useLingui()
  const page = useSearchSettingsState()
  const active = page.connections.find(({ id }) => id === page.panel)
  const close = () => page.setPanel(null)
  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane className="gap-6 md:pb-12">
          <PageHeader title={t`Search`} />
          <SettingsListBody className={settingsListBodyRowsClass}>
            {page.connections.map((connection) => (
              <SettingsSelectableRow
                key={connection.id}
                title={
                  <span className="flex items-center gap-2">
                    <span className="truncate">{connection.name}</span>
                    {connection.provider === 'tinfoil' && <PrivateBadge />}
                  </span>
                }
                subtitle={
                  canSupplySearch(connection)
                    ? getProviderDefinition(connection.provider).name
                    : t`Connect or enable this connection to use search`
                }
                ariaLabel={t`Open ${connection.name}`}
                isSelected={page.panel === connection.id}
                onSelect={() => page.setPanel(connection.id)}
                leading={
                  isSearchProvider(connection.provider) ? (
                    <SearchProviderIconTile provider={connection.provider} />
                  ) : (
                    <ModelProviderIconTile model={{ provider: connection.provider, isSystem: 0 }} />
                  )
                }
                trailing={
                  <Switch
                    disabled={page.loading}
                    checked={page.selectedId === connection.id}
                    onCheckedChange={(enabled) => page.toggle(connection.id, enabled)}
                    aria-label={
                      page.selectedId === connection.id ? t`Disable ${connection.name}` : t`Use ${connection.name}`
                    }
                  />
                }
              />
            ))}
            {page.cloudVisible && (
              <SettingsSelectableRow
                title="Thunderbolt"
                subtitle={t`Provided by your server`}
                ariaLabel={t`Open Thunderbolt`}
                isSelected={page.panel === 'cloud'}
                onSelect={() => page.setPanel('cloud')}
                leading={<ModelProviderIconTile model={{ provider: 'thunderbolt', isSystem: 1 }} />}
                trailing={
                  <Switch
                    disabled={page.loading}
                    checked={page.selectedId === 'cloud'}
                    onCheckedChange={(enabled) => page.toggle('cloud', enabled)}
                    aria-label={t`Use Thunderbolt`}
                  />
                }
              />
            )}
          </SettingsListBody>
          <Button variant="outline" asChild>
            <Link to="/settings/connections">
              <Trans>Add a connection</Trans>
            </Link>
          </Button>
        </SettingsListPane>
      </div>
      <DetailPanelSurface open={page.panel !== null} onClose={close}>
        {(active || page.panel === 'cloud') && (
          <DetailPanel title={active?.name ?? 'Thunderbolt'} onClose={close}>
            <div className="space-y-4 text-sm text-muted-foreground">
              <p>
                {active?.provider === 'tinfoil' ? (
                  <Trans>
                    Exa provides search and page content through Tinfoil’s encrypted connection and privacy filters. No
                    separate Exa API key is needed.
                  </Trans>
                ) : active?.provider === 'otari' ? (
                  <Trans>
                    Search and page content use your Otari connection and your workspace’s web access settings. Manage
                    your search provider in Otari.
                  </Trans>
                ) : active ? (
                  <Trans>Search uses this connection’s API key. Manage its credentials in Connections.</Trans>
                ) : (
                  <Trans>Search and page content are provided by your connected Thunderbolt server.</Trans>
                )}
              </p>
              <Button variant="outline" asChild>
                <Link to="/settings/connections">
                  <Trans>Manage connection</Trans>
                </Link>
              </Button>
            </div>
          </DetailPanel>
        )}
      </DetailPanelSurface>
    </div>
  )
}
export default SearchSettingsPage
