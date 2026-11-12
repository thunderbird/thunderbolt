/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useState, useTransition } from 'react'
import { BackButton } from '@/components/ui/back-button'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { memoryMcpServerUrl, type MemoryMcpProvider } from '@/memory/providers'
import { ProviderConnectionButton } from '@/components/provider-connection-button'
import { MemoryProviderLogo } from '@/components/memory-provider-logo'

/** Uses the existing MCP OAuth flow; provider setup only supplies its trusted endpoint. */
export const MemoryProviderForm = ({
  provider,
  pending: externalPending,
  error,
  onConnect,
  onCancel,
  onBack,
}: {
  provider: MemoryMcpProvider
  pending: boolean
  error: string | null
  onConnect: (url: string, name: string) => Promise<void>
  onCancel?: () => void
  onBack: () => void
}) => {
  const { t } = useLingui()
  const [bankId, setBankId] = useState('')
  const [connecting, startConnecting] = useTransition()
  const pending = externalPending || connecting
  const valid = !provider.bankScoped || /^[a-zA-Z0-9_-]+$/.test(bankId.trim())
  const connect = () => {
    if (!valid || pending) {
      return
    }
    startConnecting(async () => {
      await onConnect(
        memoryMcpServerUrl(provider, bankId.trim()),
        provider.bankScoped ? `${provider.name} · ${bankId.trim()}` : provider.name,
      )
    })
  }
  return (
    <form
      className="flex flex-1 flex-col items-center gap-4 pt-8"
      onSubmit={(event) => {
        event.preventDefault()
        connect()
      }}
    >
      <span className="mb-2 flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/40">
        <MemoryProviderLogo provider={provider.id} className="size-7" />
      </span>
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        <Trans>
          Sign in to {provider.name} to let your agent use the memories you authorize there. These memories are stored
          by the provider.
        </Trans>
      </p>
      {provider.id === 'zep' && (
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          <Trans>Your organization must enable Zep MCP access before you can connect.</Trans>
        </p>
      )}
      {provider.bankScoped && (
        <div className="flex w-full flex-col gap-2">
          <Label htmlFor="memory-bank-id">
            <Trans>Memory bank ID</Trans>
          </Label>
          <Input
            id="memory-bank-id"
            value={bankId}
            onChange={(event) => setBankId(event.target.value)}
            placeholder={t`Your Hindsight bank ID`}
            disabled={pending}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            <Trans>Use the bank ID from Hindsight Cloud's Connect page. Only that bank will be connected.</Trans>
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="max-w-sm text-center text-sm text-destructive">
          {error}
        </p>
      )}
      <ProviderConnectionButton
        isConnected={false}
        isProcessing={pending}
        connectLabel={t`Connect ${provider.name}`}
        disabled={!valid && !pending}
        onConnect={connect}
        onCancel={onCancel}
      />
      <a
        href={provider.documentationUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        <Trans>Setup instructions</Trans>
      </a>
      <FormFooter className="w-full items-center justify-between">
        <BackButton
          onClick={() => {
            onCancel?.()
            onBack()
          }}
          disabled={pending && !onCancel}
        />
        <Button type="button" disabled>
          <Trans>Continue</Trans>
        </Button>
      </FormFooter>
    </form>
  )
}
