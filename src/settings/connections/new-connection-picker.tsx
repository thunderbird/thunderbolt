/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Filter, Plug } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
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
  otariEnabled = false,
}: {
  onProvider: (provider: ProviderType) => void
  onMcp?: () => void
  integrations?: Integration[]
  onIntegration?: (id: string) => void
  otariEnabled?: boolean
  capability?: ProviderCapability
}) => {
  const { t, i18n } = useLingui()
  const [search, setSearch] = useState('')
  const [types, setTypes] = useState<string[]>([])
  const matchesType = (categories: readonly string[]) =>
    types.length === 0 || categories.some((category) => types.includes(category))
  const typeOptions = [
    { id: 'models', label: t`Models` },
    { id: 'search', label: t`Search` },
    { id: 'productivity', label: t`Productivity` },
  ]
  const query = search.trim().toLowerCase()
  /** Match the visible labels without making case or surrounding spaces significant. */
  const matchesSearch = (label: string) => label.toLowerCase().includes(query)
  const genericOptions = capability
    ? []
    : [
        {
          id: 'mcp',
          description: undefined as string | undefined,
          label: t`MCP server`,
          icon: <Plug className="size-5" />,
          onSelect: onMcp,
        },
        {
          id: 'custom',
          description: undefined as string | undefined,
          label: t`OpenAI-compatible model provider`,
          icon: <ProviderConnectionIcon provider="custom" />,
          onSelect: () => onProvider('custom'),
        },
      ].filter((option) => matchesSearch(option.label) && (option.id === 'mcp' || matchesType(['models'])))
  const providers = providerDefinitions
    .filter(
      (provider) =>
        provider.id !== 'custom' &&
        (provider.id !== 'otari' || otariEnabled) &&
        (!capability || provider.capabilities.includes(capability)) &&
        matchesType(provider.capabilities),
    )
    .map((provider) => ({
      ...provider,
      description: provider.capabilities.includes('models')
        ? provider.capabilities.includes('search')
          ? t`Models and search`
          : t`Models`
        : t`Search`,
    }))
    .filter((provider) => matchesSearch(`${provider.name} ${provider.description}`))
  const options = [
    ...providers.map((provider) => ({
      id: `provider:${provider.id}`,
      label: provider.name,
      description: provider.description,
      icon: <ProviderConnectionIcon provider={provider.id} />,
      onSelect: () => onProvider(provider.id),
    })),
    ...integrations
      .filter((integration) => {
        const category = integration.provider === 'thunderbolt-pro' ? 'search' : 'productivity'
        return (
          matchesType([category]) &&
          matchesSearch(`${integration.name} ${category === 'productivity' ? t`Productivity` : t`Search`}`)
        )
      })
      .map((integration) => ({
        id: `integration:${integration.id}`,
        label: integration.name,
        description: integration.provider === 'thunderbolt-pro' ? t`Search` : t`Productivity`,
        icon: integration.icon,
        onSelect: () => onIntegration?.(integration.id),
      })),
  ].sort((a, b) => a.label.localeCompare(b.label, i18n.locale, { sensitivity: 'base' }))

  return (
    <div className="flex flex-col gap-2">
      <div className="mb-2 flex items-center gap-2">
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t`Search connections…`}
          aria-label={t`Search connections`}
          className="min-w-0 flex-1"
          autoFocus
        />
        {!capability && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={t`Filter by type`}
                className={types.length ? 'text-primary' : undefined}
              >
                <Filter />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>
                <Trans>Connection type</Trans>
              </DropdownMenuLabel>
              {typeOptions.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.id}
                  checked={types.includes(option.id)}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) =>
                    setTypes((current) =>
                      checked ? [...current, option.id] : current.filter((id) => id !== option.id),
                    )
                  }
                >
                  {option.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {[...genericOptions, ...options].map((option, index) => (
        <Fragment key={option.id}>
          {index > 0 && index === genericOptions.length && (
            <Separator decorative={false} className="my-1 bg-border/60" />
          )}
          <Button
            type="button"
            variant="outline"
            className="justify-start whitespace-normal text-left"
            onClick={option.onSelect}
          >
            <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center">
              {option.icon}
            </span>
            <span className="flex-1 text-left">{option.label}</span>
            {option.description && <span className="text-xs text-muted-foreground">{option.description}</span>}
          </Button>
        </Fragment>
      ))}
      {genericOptions.length + options.length === 0 && (
        <SettingsNoResults role="status">
          <Trans>No connections found.</Trans>
        </SettingsNoResults>
      )}
    </div>
  )
}
