/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Check } from 'lucide-react'
import { MemoryProviderLogo } from '@/components/memory-provider-logo'
import { ProviderConnectionButton } from '@/components/provider-connection-button'
import { Button } from '@/components/ui/button'
import type { StatusState } from '@/components/status-indicator'
import type { OAuthCardState } from '@/hooks/use-mcp-server-oauth'
import type { MemoryMcpProvider } from '@/memory/providers'

type MemoryConnectionStatusProps = {
  provider: MemoryMcpProvider
  enabled: boolean
  status: StatusState
  oauthState: OAuthCardState | { phase: 'authorized' } | null
  connectionError: Error | null
  actionError: string | null
  isRetrying: boolean
  onRetry: () => void
  onAuthorize: () => void
  onCancelAuthorize?: () => void
  onEnable?: () => void
}

/** Memory accounts use the same centered connection treatment as model providers. */
export const MemoryConnectionStatus = ({
  provider,
  enabled,
  status,
  oauthState,
  connectionError,
  actionError,
  isRetrying,
  onRetry,
  onAuthorize,
  onCancelAuthorize,
  onEnable,
}: MemoryConnectionStatusProps) => {
  const { t } = useLingui()
  const connected = enabled && status === 'connected' && !connectionError
  const authorizing = oauthState?.phase === 'authorizing'
  const processing = authorizing || isRetrying || (enabled && status === 'connecting')
  const error = actionError ?? (oauthState?.phase === 'error' ? oauthState.message : connectionError?.message)
  return (
    <div className="flex flex-col items-center gap-6 px-4 py-8 text-center">
      <div className="relative">
        <span className="flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/40">
          <MemoryProviderLogo provider={provider.id} className="size-7" />
        </span>
        {connected && (
          <span className="absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full bg-brand text-brand-foreground ring-2 ring-sidebar [background-image:var(--gradient-brand)]">
            <Check className="size-3" aria-hidden="true" />
          </span>
        )}
      </div>
      <div role="status" className="flex max-w-full flex-col gap-2">
        <h3 className="text-xl font-medium tracking-tight">
          {connected ? <Trans>Connected to {provider.name}</Trans> : provider.name}
        </h3>
        <p className="text-sm text-muted-foreground">
          {!enabled ? (
            <Trans>This connection is disabled.</Trans>
          ) : connected ? (
            <Trans>Ready to use as your memory provider.</Trans>
          ) : (
            <Trans>Connect on this device</Trans>
          )}
        </p>
      </div>
      {error && (
        <p role="alert" className="max-w-sm break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {connected && !authorizing ? (
        <Button variant="outline" size="sm" onClick={onAuthorize} disabled={isRetrying}>
          <Trans>Re-authorize</Trans>
        </Button>
      ) : (
        <ProviderConnectionButton
          isConnected={false}
          isProcessing={processing}
          connectLabel={
            !enabled ? t`Enable connection` : connectionError ? t`Retry connection` : t`Connect ${provider.name}`
          }
          onConnect={!enabled && onEnable ? onEnable : connectionError ? onRetry : onAuthorize}
          onCancel={authorizing ? onCancelAuthorize : undefined}
          disabled={!enabled && !onEnable}
        />
      )}
      <a
        href={provider.documentationUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <Trans>Setup instructions</Trans>
      </a>
    </div>
  )
}
