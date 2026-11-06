/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Plug } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsNoResults } from '@/components/settings/settings-empty-state'
import { providerDefinitions } from '@/providers/registry'
import type { Integration } from './types'
import type { ProviderCapability, ProviderType } from '@/providers/types'
import { ProviderConnectionIcon } from './provider-connection-icon'

/** One entry point for AI providers, search providers, and existing MCP setup. */
export const NewConnectionPicker = ({
  onProvider,
  onMcp,
  integrations = [],
  onIntegration,
  capability,
}: {
  onProvider: (provider: ProviderType) => void
  onMcp?: () => void
  integrations?: Integration[]
  onIntegration?: (id: string) => void
  capability?: ProviderCapability
}) => {
  const { t } = useLingui()
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  /** Match the visible labels without making case or surrounding spaces significant. */
  const matchesSearch = (label: string) => label.toLowerCase().includes(query)
  const genericOptions = capability
    ? []
    : [
        { id: 'mcp', label: t`MCP server`, icon: <Plug className="size-5" />, onSelect: onMcp },
        {
          id: 'custom',
          label: t`OpenAI-compatible model provider`,
          icon: <ProviderConnectionIcon provider="custom" />,
          onSelect: () => onProvider('custom'),
        },
      ].filter((option) => matchesSearch(option.label))
  const providers = providerDefinitions
    .filter((provider) => provider.id !== 'custom' && (!capability || provider.capabilities.includes(capability)))
    .map((provider) => ({
      ...provider,
      description: provider.capabilities.includes('models')
        ? provider.capabilities.includes('search')
          ? t`Models and search`
          : t`Models`
        : t`Search`,
    }))
    .filter((provider) => matchesSearch(`${provider.name} ${provider.description}`))
  const visibleIntegrations = integrations.filter((integration) => matchesSearch(integration.name))

  return (
    <div className="flex flex-col gap-2">
      <Input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={t`Search connections…`}
        aria-label={t`Search connections`}
        className="mb-2"
        autoFocus
      />
      {genericOptions.length > 0 && (
        <div className="mb-3 grid gap-2 border-b pb-4">
          {genericOptions.map((option) => (
            <Button
              key={option.id}
              type="button"
              variant="secondary"
              className="justify-start whitespace-normal text-left"
              onClick={option.onSelect}
            >
              {option.icon}
              {option.label}
            </Button>
          ))}
        </div>
      )}
      {providers.map((provider) => (
        <Button
          key={provider.id}
          type="button"
          variant="outline"
          className="justify-start"
          onClick={() => onProvider(provider.id)}
        >
          <ProviderConnectionIcon provider={provider.id} />
          <span className="flex-1 text-left">{provider.name}</span>
          <span className="text-xs text-muted-foreground">{provider.description}</span>
        </Button>
      ))}
      {visibleIntegrations.map((integration) => (
        <Button
          key={integration.id}
          type="button"
          aria-label={integration.name}
          variant="outline"
          className="justify-start"
          onClick={() => onIntegration?.(integration.id)}
        >
          <span className="flex size-5 items-center justify-center">{integration.icon}</span>
          <span className="flex-1 text-left">{integration.name}</span>
        </Button>
      ))}
      {genericOptions.length + providers.length + visibleIntegrations.length === 0 && (
        <SettingsNoResults role="status">
          <Trans>No connections found.</Trans>
        </SettingsNoResults>
      )}
    </div>
  )
}
