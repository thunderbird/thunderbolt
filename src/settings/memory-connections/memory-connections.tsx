/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Plus } from 'lucide-react'
import { memoryProviderForServer } from '@/memory/selection'
import { MemoryProviderLogo } from '@/components/memory-provider-logo'
import { Button } from '@/components/ui/button'
import { MemoryProviderOption } from './memory-provider-option'
import { BuiltInMemoryCard, type BuiltInMemoryCardContent } from './built-in-memory-card'
import { useMemoryConnectionsState } from './use-memory-connections-state'

type MemoryConnectionsProps = {
  selectedProvider: string
  onSelect: (id: string) => void
  disabled?: boolean
  builtinMemory: BuiltInMemoryCardContent
}

/** One provider owns memory; connections continue to use the shared OAuth setup surface. */
export const MemoryConnections = ({
  selectedProvider,
  onSelect,
  disabled = false,
  builtinMemory,
}: MemoryConnectionsProps) => {
  const { t } = useLingui()
  const state = useMemoryConnectionsState()
  const selectedConnection = state.connections.find(({ id }) => memoryProviderForServer(id) === selectedProvider)
  return (
    <section className="flex flex-col gap-4" aria-labelledby="memory-provider-heading">
      <div className="flex items-center justify-between gap-3">
        <h2 id="memory-provider-heading" className="text-lg font-semibold">
          <Trans>Memory provider</Trans>
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="border bg-card hover:bg-accent"
          aria-label={t`Add connection`}
          title={t`Add connection`}
          disabled={disabled}
          onClick={state.add}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>
      <div
        role="radiogroup"
        aria-labelledby="memory-provider-heading"
        className="divide-y overflow-hidden rounded-xl border"
      >
        <BuiltInMemoryCard
          memory={builtinMemory}
          selected={selectedProvider === 'builtin'}
          disabled={disabled}
          onSelect={onSelect}
        />
        {state.connections.map((server) => (
          <MemoryProviderOption
            key={server.id}
            id={memoryProviderForServer(server.id)}
            name={server.name}
            subtitle={server.disabled ? t`Disabled` : server.connected ? t`Connected` : t`Not connected`}
            icon={<MemoryProviderLogo provider={server.providerId} />}
            selected={selectedProvider === memoryProviderForServer(server.id)}
            disabled={disabled}
            onSelect={onSelect}
            onManage={() => state.manage(server.id)}
          />
        ))}
      </div>
      {!state.isLoading && selectedProvider !== 'builtin' && !selectedConnection && (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Selected provider is unavailable. Choose another provider to resume memory.</Trans>
        </p>
      )}
      {selectedConnection && (selectedConnection.disabled || !selectedConnection.connected) && (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Connect and enable this provider to use memory.</Trans>
        </p>
      )}
    </section>
  )
}
