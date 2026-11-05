/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Link } from 'react-router'
import { ProviderBrandLogo } from '@/components/provider-brand-logo'
import { IconTile } from '@/components/settings/icon-tile'
import { DetailPanel, DetailPanelSurface } from '@/components/detail-panel'
import {
  SettingsListBody,
  SettingsListPane,
  SettingsSelectableRow,
  settingsListBodyRowsClass,
} from '@/components/settings/settings-list'
import { SearchProviderSetup } from '@/components/search-provider-setup'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'
import { PrivateBadge } from '@/components/ui/private-badge'
import { Switch } from '@/components/ui/switch'
import { isSearchProvider, searchProviders, type SearchProvider } from '@/integrations/standalone-search/providers'
import { ModelProviderIconTile } from '@/settings/models/model-presentation'
import { SearchProviderIconTile } from './search-provider-icon-tile'
import { useSearchSettingsState } from './use-search-settings-state'

const SearchSettingsPage = () => {
  const { t } = useLingui()
  const page = useSearchSettingsState()
  const tinfoilName = 'Tinfoil'
  const rows = [
    {
      id: 'tinfoil' as const,
      name: tinfoilName,
      subtitle: t`Exa search through Tinfoil`,
    },
    ...Object.entries(searchProviders).map(([id, provider]) => ({
      id: id as SearchProvider,
      name: provider.name,
      subtitle:
        page.available.custom && page.stored.provider === id ? t`Your API key` : t`Connect with your own API key`,
    })),
    ...(page.available.cloud
      ? [{ id: 'cloud' as const, name: 'Thunderbolt', subtitle: t`Provided by your server` }]
      : []),
  ]
  const close = () => page.setPanel(null)
  return (
    <div className="relative flex h-full">
      <div className="min-w-0 flex-1 overflow-hidden">
        <SettingsListPane className="gap-6 md:pb-12">
          <PageHeader title={t`Search`} />
          <SettingsListBody className={settingsListBodyRowsClass}>
            {rows.map(({ id, name, subtitle }) => (
              <SettingsSelectableRow
                key={id}
                title={
                  <span className="flex items-center gap-2">
                    <span className="truncate">{name}</span>
                    {id === 'tinfoil' && <PrivateBadge />}
                  </span>
                }
                subtitle={subtitle}
                ariaLabel={t`Open ${name}`}
                isSelected={page.panel === id}
                onSelect={() => page.setPanel(id)}
                leading={
                  isSearchProvider(id) ? (
                    <SearchProviderIconTile provider={id} />
                  ) : id === 'tinfoil' ? (
                    <IconTile>
                      <ProviderBrandLogo provider="tinfoil" className="size-5" />
                    </IconTile>
                  ) : (
                    <ModelProviderIconTile
                      model={{
                        provider: 'thunderbolt',
                        isSystem: 1,
                      }}
                    />
                  )
                }
                trailing={
                  <Switch
                    disabled={page.loading}
                    checked={page.selected === id}
                    onCheckedChange={(enabled) => page.toggle(id, enabled)}
                    aria-label={page.selected === id ? t`Disable ${name}` : t`Use ${name}`}
                  />
                }
              />
            ))}
          </SettingsListBody>
        </SettingsListPane>
      </div>
      <DetailPanelSurface open={page.panel !== null} onClose={close}>
        {page.panel && isSearchProvider(page.panel) ? (
          <DetailPanel title={searchProviders[page.panel].name} onClose={close}>
            {page.available.custom && page.stored.provider !== page.panel && (
              <p className="mb-4 text-sm text-muted-foreground">
                <Trans>Connecting this provider replaces your saved search API key.</Trans>
              </p>
            )}
            <SearchProviderSetup key={page.panel} provider={page.panel} />
          </DetailPanel>
        ) : (
          page.panel && (
            <DetailPanel title={page.panel === 'tinfoil' ? tinfoilName : 'Thunderbolt'} onClose={close}>
              <div className="space-y-4 text-sm text-muted-foreground">
                <p>
                  {page.panel === 'tinfoil' ? (
                    <Trans>
                      Exa provides search and page content through Tinfoil’s encrypted connection and privacy filters.
                      No separate Exa API key is needed.
                    </Trans>
                  ) : (
                    <Trans>Search and page content are provided by your connected Thunderbolt server.</Trans>
                  )}
                </p>
                {page.panel === 'tinfoil' && !page.available.tinfoil && (
                  <p>
                    <Trans>Enable or reconnect Tinfoil in Connections to use this provider.</Trans>
                  </p>
                )}
                {page.panel === 'tinfoil' && (
                  <Button variant="outline" asChild>
                    <Link to="/settings/connections">
                      <Trans>Manage connection</Trans>
                    </Link>
                  </Button>
                )}
              </div>
            </DetailPanel>
          )
        )}
      </DetailPanelSurface>
    </div>
  )
}

export default SearchSettingsPage
