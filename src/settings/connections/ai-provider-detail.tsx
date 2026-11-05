/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { TinfoilImpactDialog } from './tinfoil-impact-dialog'
import { Trans } from '@lingui/react/macro'
import { DetailPanel, DetailSectionTitle } from '@/components/detail-panel'
import { useOnboardingModelState } from '@/components/onboarding/use-onboarding-model-state'
import { useOnboardingProviderState } from '@/components/onboarding/use-onboarding-provider-state'
import { ProviderBrandLogo } from '@/components/provider-brand-logo'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { openExternalUrl } from '@/lib/open-external-url'
import { tinfoilManageSubscriptionUrl } from '@/lib/tinfoil-auth'
import type { AiProviderConnection } from './types'

/** Account controls shared by the AI providers, separate from model configuration. */
export const AiProviderDetail = ({
  connection,
  onClose,
}: {
  connection: AiProviderConnection & { id: 'openrouter' | 'tinfoil' }
  onClose: () => void
}) => {
  const { id, name, connected, needsReauth, oauthConnected } = connection
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const { disconnectProvider } = useOnboardingModelState()
  const state = useOnboardingProviderState(connected ? [id] : [], undefined, undefined, {
    initialProvider: id,
    returnContext: 'connections',
    onSaved: onClose,
  })
  const busy = state.isConnecting || state.isDisconnecting || state.addForm.isPending
  const connect = id === 'tinfoil' ? state.connectTinfoil : state.connectOpenRouter
  const disconnect = () =>
    state.disconnectProvider(async () => {
      await disconnectProvider(id)
      setConfirmDisconnect(false)
    })
  return (
    <DetailPanel title={name} icon={<ProviderBrandLogo provider={id} />} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <DetailSectionTitle>
          <Trans>Account</Trans>
        </DetailSectionTitle>
        <p className="text-sm text-muted-foreground">
          {needsReauth ? (
            <Trans>Your connection has expired. Reconnect to continue.</Trans>
          ) : connected ? (
            <Trans>Connected</Trans>
          ) : id === 'tinfoil' ? (
            <Trans>Connect with a paid Tinfoil subscription.</Trans>
          ) : (
            <Trans>Sign in to connect your account.</Trans>
          )}
        </p>
        {state.showApiKey && (!connected || needsReauth) ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault()
              void state.connectApiKey()
            }}
          >
            <Label htmlFor="provider-api-key">
              <Trans>API Key</Trans>
            </Label>
            <Input
              id="provider-api-key"
              type="password"
              autoComplete="off"
              disabled={busy}
              {...state.addForm.form.register('apiKey')}
            />
            <Button type="submit" disabled={busy || !state.addForm.form.watch('apiKey')?.trim()} isLoading={busy}>
              <Trans>Connect</Trans>
            </Button>
            <Button type="button" variant="link" size="sm" disabled={busy} onClick={state.cancelConnection}>
              <Trans>Use sign-in instead</Trans>
            </Button>
          </form>
        ) : state.view === 'manual' ? (
          <>
            <p className="text-sm text-muted-foreground">
              <Trans>Finish connecting in your browser, then paste the authorization code here.</Trans>
            </p>
            <Label htmlFor="provider-code">
              <Trans>Authorization code</Trans>
            </Label>
            <Input
              id="provider-code"
              value={state.code}
              onChange={(event) => state.setCode(event.target.value)}
              autoComplete="off"
              disabled={busy}
            />
            <Button onClick={state.submitCode} disabled={!state.code.trim() || busy} isLoading={busy}>
              <Trans>Connect {name}</Trans>
            </Button>
          </>
        ) : (
          (!connected || needsReauth) && (
            <Button
              variant={connected ? 'outline' : 'default'}
              disabled={busy}
              isLoading={state.isConnecting || state.addForm.isPending}
              onClick={connect}
            >
              {needsReauth ? <Trans>Reconnect {name}</Trans> : <Trans>Connect {name}</Trans>}
            </Button>
          )
        )}
        {!connected && !state.showApiKey && !busy && state.view !== 'manual' && (
          <Button variant="link" size="sm" className="text-muted-foreground" onClick={state.useApiKey}>
            <Trans>Use an API key instead</Trans>
          </Button>
        )}
        {connected && (
          <div className="flex flex-wrap gap-2">
            {id === 'tinfoil' && oauthConnected && (
              <Button variant="outline" size="sm" onClick={() => openExternalUrl(tinfoilManageSubscriptionUrl)}>
                <Trans>Manage subscription</Trans>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              isLoading={state.isDisconnecting}
              onClick={() => (id === 'tinfoil' ? setConfirmDisconnect(true) : void disconnect())}
            >
              <Trans>Disconnect</Trans>
            </Button>
          </div>
        )}
        {(state.isConnecting || state.view === 'manual') && !state.addForm.isPending && (
          <Button variant="ghost" size="sm" onClick={state.cancelConnection}>
            <Trans>Cancel connection</Trans>
          </Button>
        )}
        {connected && id === 'tinfoil' && oauthConnected && (
          <p className="text-xs text-muted-foreground">
            <Trans>Disconnecting does not cancel your subscription.</Trans>
          </p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
      </div>
      <TinfoilImpactDialog
        action="disconnect"
        open={confirmDisconnect}
        pending={state.isDisconnecting}
        error={state.error}
        onCancel={() => setConfirmDisconnect(false)}
        onConfirm={() => void disconnect()}
      />
    </DetailPanel>
  )
}
