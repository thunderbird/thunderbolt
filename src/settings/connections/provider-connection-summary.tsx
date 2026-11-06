/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { getProviderDefinition } from '@/providers/registry'
import type { ProviderConnection } from '@/providers/types'
import { ProviderConnectionIcon } from './provider-connection-icon'

/** Shared saved-connection summary; only OAuth sign-ins carry an authorization check. */
export const ProviderConnectionSummary = ({
  connection,
  onAddApiKey,
  children,
}: {
  connection: ProviderConnection
  onAddApiKey?: () => void
  children?: ReactNode
}) => {
  const definition = getProviderDefinition(connection.provider)
  const name = connection.provider === 'openai' && connection.authMethod === 'oauth' ? 'ChatGPT' : definition.name
  const oauth = connection.authMethod === 'oauth'
  const customUrl = connection.url && connection.url !== definition.defaultUrl ? connection.url : null
  return (
    <div className="flex flex-col items-center gap-6 px-4 py-8 text-center">
      <div className="relative">
        <span className="flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/40">
          <ProviderConnectionIcon provider={connection.provider} />
        </span>
        {oauth && (
          <span className="absolute -bottom-1 -right-1 flex size-6 items-center justify-center rounded-full bg-success text-white ring-4 ring-sidebar">
            <Check className="size-3.5" aria-hidden="true" />
          </span>
        )}
      </div>
      <div role="status" className="flex max-w-full flex-col gap-2">
        <h3 className="text-xl font-medium tracking-tight">
          {connection.needsConsent ? (
            <Trans>Signed in to {name}</Trans>
          ) : oauth ? (
            <Trans>Connected to {name}</Trans>
          ) : (
            name
          )}
        </h3>
        {connection.needsConsent && (
          <p className="text-sm text-muted-foreground">
            <Trans>Allow access to your ChatGPT plan to use its models. You can also add an API-key connection.</Trans>
          </p>
        )}
        {customUrl && <p className="break-all text-sm text-muted-foreground">{customUrl}</p>}
      </div>
      {children}
      {onAddApiKey && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto whitespace-normal px-0 text-xs font-normal text-muted-foreground hover:text-foreground"
          onClick={onAddApiKey}
        >
          <Trans>Add another instance via API key</Trans>
        </Button>
      )}
    </div>
  )
}
