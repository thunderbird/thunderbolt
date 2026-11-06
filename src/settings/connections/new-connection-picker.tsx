/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  return (
    <div className="flex flex-col gap-2">
      {!capability && (
        <div className="mb-3 grid gap-2 border-b pb-4">
          <Button variant="secondary" className="justify-start" onClick={onMcp}>
            <Plug className="size-5" />
            <Trans>MCP server</Trans>
          </Button>
          <Button variant="secondary" className="justify-start" onClick={() => onProvider('custom')}>
            <ProviderConnectionIcon provider="custom" />
            <Trans>OpenAI-compatible</Trans>
          </Button>
        </div>
      )}
      {providerDefinitions
        .filter((provider) => provider.id !== 'custom' && (!capability || provider.capabilities.includes(capability)))
        .map((provider) => (
          <Button key={provider.id} variant="outline" className="justify-start" onClick={() => onProvider(provider.id)}>
            <ProviderConnectionIcon provider={provider.id} />
            <span className="flex-1 text-left">{provider.name}</span>
            <span className="text-xs text-muted-foreground">
              {provider.capabilities.includes('models')
                ? provider.capabilities.includes('search')
                  ? t`Models and search`
                  : t`Models`
                : t`Search`}
            </span>
          </Button>
        ))}
      {integrations.map((integration) => (
        <Button
          key={integration.id}
          aria-label={integration.name}
          variant="outline"
          className="justify-start"
          onClick={() => onIntegration?.(integration.id)}
        >
          <span className="flex size-5 items-center justify-center">{integration.icon}</span>
          <span className="flex-1 text-left">{integration.name}</span>
        </Button>
      ))}
    </div>
  )
}
