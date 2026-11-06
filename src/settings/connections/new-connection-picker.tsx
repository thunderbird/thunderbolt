/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Plug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { providerDefinitions } from '@/providers/registry'
import type { ProviderType } from '@/providers/types'
import { ProviderConnectionIcon } from './provider-connection-icon'

/** One entry point for AI providers, search providers, and existing MCP setup. */
export const NewConnectionPicker = ({
  onProvider,
  onMcp,
}: {
  onProvider: (provider: ProviderType) => void
  onMcp: () => void
}) => {
  const { t } = useLingui()
  return (
    <div className="flex flex-col gap-2">
      {providerDefinitions.map((provider) => (
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
      <Button variant="outline" className="mt-2 justify-start" onClick={onMcp}>
        <Plug className="size-5" />
        <Trans>MCP server</Trans>
      </Button>
    </div>
  )
}
