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
import { PageCreateAction } from '@/components/ui/page-create-action'
import { NewConnectionPicker } from '@/settings/connections/new-connection-picker'
import { ProviderConnectionForm } from '@/settings/connections/provider-connection-form'
import { getProviderDefinition, providerDefinitions } from '@/providers/registry'
import { useProviderAuthorization } from '@/providers/use-provider-authorization'
import { PageHeader } from '@/components/ui/page-header'
import { PrivateBadge } from '@/components/ui/private-badge'
import { Switch } from '@/components/ui/switch'
import { canSupplySearch } from '@/integrations/standalone-search/eligibility'
import { isSearchProvider } from '@/integrations/standalone-search/providers'
import { ModelProviderIconTile } from '@/settings/models/model-presentation'
import { SearchProviderIconTile } from './search-provider-icon-tile'
import { useSearchSettingsState } from './use-search-settings-state'

const SearchSettingsPage = () => {
  const { t } = useLingui()
  const page = useSearchSettingsState()
  const authorization = useProviderAuthorization({ onConnected: (id) => page.setPanel(id) })
  const adding = providerDefinitions.find((provider) => page.panel === `add:${provider.id}`)
  const active = page.connections.find(({ id }) => id === page.panel)
  const close = () => {
    authorization.cancel()
    page.setPanel(null)
  }
  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane className="gap-6 md:pb-12">
          <PageHeader title={t`Search`}>
            <PageCreateAction label={t`New Search Connection`} onClick={() => page.setPanel('new')} />
          </PageHeader>
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
        </SettingsListPane>
      </div>
      <DetailPanelSurface open={page.panel !== null} onClose={close}>
        {page.panel === 'new' && (
          <DetailPanel title={t`New Search Connection`} onClose={close}>
            <NewConnectionPicker capability="search" onProvider={(id) => page.setPanel(`add:${id}`)} />
          </DetailPanel>
        )}
        {adding && (
          <DetailPanel title={adding.name} onClose={close}>
            <ProviderConnectionForm
              key={adding.id}
              provider={adding.id}
              authorization={authorization}
              existingOAuth={page.connections.find(
                (connection) => connection.provider === adding.id && connection.authMethod === 'oauth',
              )}
              onSaved={(id) => page.setPanel(id)}
              onCancel={close}
            />
          </DetailPanel>
        )}
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
