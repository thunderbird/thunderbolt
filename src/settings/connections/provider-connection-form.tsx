/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { BackButton } from '@/components/ui/back-button'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProviderConnectionButton } from '@/components/provider-connection-button'
import type { ProviderAuthMethod, ProviderConnection, ProviderType } from '@/providers/types'
import type { useProviderAuthorization } from '@/providers/use-provider-authorization'
import { useProviderConnectionForm } from './use-provider-connection-form'
import { ProviderConnectionIcon } from './provider-connection-icon'
import { cn } from '@/lib/utils'
import { canConnectChatGPT } from '@/providers/chatgpt-auth'
import { ConnectionSetupFooter } from './connection-setup-footer'
import { ChatGPTAccountPicker } from './chatgpt-account-picker'
import { ProviderConnectionSummary } from './provider-connection-summary'

/** Adds, reconnects, or edits a provider without requiring a model. */
export const ProviderConnectionForm = ({
  provider,
  connection,
  existingOAuth,
  authorization,
  onSaved,
  onCancel,
  onBack,
  onAddApiKey,
  mode = 'connect',
  initialAuthMethod,
  hideName = false,
}: {
  provider: ProviderType
  connection?: ProviderConnection
  existingOAuth?: ProviderConnection
  authorization: Omit<ReturnType<typeof useProviderAuthorization>, 'processMcpCallback'>
  onSaved: (id: string) => void
  onCancel: () => void
  onBack?: () => void
  onAddApiKey?: () => void
  mode?: 'connect' | 'edit'
  initialAuthMethod?: ProviderAuthMethod
  hideName?: boolean
}) => {
  const { t } = useLingui()
  const state = useProviderConnectionForm({
    provider,
    connection,
    existingOAuth,
    authorization,
    onSaved,
    mode,
    initialAuthMethod,
  })
  const name = state.definition.name
  const oauthConnect = state.authMethod === 'oauth' && !state.editing
  const existingSignIn = !connection && state.authMethod === 'oauth' ? existingOAuth : undefined
  const toggleAuthMethod = () => {
    authorization.cancel()
    if (state.authMethod === 'api_key' && existingOAuth) {
      onSaved(existingOAuth.id)
      return
    }
    state.dispatch({ field: 'authMethod', value: state.authMethod === 'oauth' ? 'api_key' : 'oauth' })
  }
  if (existingSignIn?.connected) {
    return (
      <>
        <ProviderConnectionSummary connection={existingSignIn} onAddApiKey={toggleAuthMethod} />
        {onBack && <ConnectionSetupFooter onBack={onBack} onContinue={() => onSaved(existingSignIn.id)} ready />}
      </>
    )
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        state.submit()
      }}
      className={cn('flex flex-1 flex-col gap-4', oauthConnect && 'items-center pt-8')}
    >
      {oauthConnect && (
        <span className="mb-2 flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/40">
          <ProviderConnectionIcon provider={provider} />
        </span>
      )}
      {!hideName && !existingSignIn && !oauthConnect && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="connection-name">
            <Trans>Name</Trans>
          </Label>
          <Input
            id="connection-name"
            value={state.name}
            onChange={(event) => state.dispatch({ field: 'name', value: event.target.value })}
            required
            disabled={state.busy}
            autoComplete="off"
            autoFocus={state.editing}
          />
        </div>
      )}
      {existingSignIn && (
        <p className="text-sm text-muted-foreground">
          <Trans>Sign in to reconnect {name} on this device.</Trans>
        </p>
      )}
      {!existingSignIn &&
        !state.oauthLocked &&
        state.definition.requiresUrl &&
        (state.editing || provider !== 'otari' || state.customUrl) && (
          <div className="flex w-full flex-col gap-2">
            <Label htmlFor="connection-url">
              <Trans>Server URL</Trans>
            </Label>
            <Input
              id="connection-url"
              type="url"
              value={state.url}
              onChange={(event) => state.dispatch({ field: 'url', value: event.target.value })}
              placeholder={provider === 'otari' ? t`http://localhost:8099` : t`http://localhost:11434/v1`}
              required
              disabled={state.busy || state.oauthLocked}
              autoComplete="url"
              autoFocus={provider === 'otari' && !state.editing}
            />
          </div>
        )}
      {state.authMethod === 'api_key' && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="connection-api-key">
            {provider === 'custom' ? <Trans>API key (optional)</Trans> : <Trans>API key</Trans>}
          </Label>
          <Input
            id="connection-api-key"
            type="password"
            value={state.apiKey}
            onChange={(event) => state.dispatch({ field: 'apiKey', value: event.target.value })}
            required={provider !== 'custom' && (!state.editing || state.urlChanged)}
            disabled={state.busy || state.oauthLocked}
            autoComplete="off"
            aria-describedby="connection-api-key-help"
            placeholder={state.editing && !state.urlChanged ? t`********` : undefined}
          />
          <p id="connection-api-key-help" className="text-xs text-muted-foreground">
            <Trans>Credentials stay on this device.</Trans>
          </p>
        </div>
      )}
      {authorization.manual && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="connection-code">
            <Trans>Authorization code</Trans>
          </Label>
          <Input
            id="connection-code"
            value={authorization.manual.code}
            onChange={(event) => authorization.manual?.setCode(event.target.value)}
            autoComplete="off"
          />
          <Button type="button" onClick={authorization.manual.submit} disabled={!authorization.manual.code.trim()}>
            <Trans>Complete connection</Trans>
          </Button>
        </div>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {oauthConnect && (
        <ProviderConnectionButton
          isConnected={false}
          isProcessing={authorization.isPending}
          connectLabel={provider === 'openai' ? t`Continue with ChatGPT` : t`Connect ${name}`}
          disabled={(!state.valid && !authorization.isPending) || (provider === 'openai' && !canConnectChatGPT())}
          onConnect={state.submit}
          onCancel={authorization.cancel}
        />
      )}
      {oauthConnect && provider === 'openai' && canConnectChatGPT() && (
        <ChatGPTAccountPicker
          isPending={false}
          disabled={state.busy}
          onCancel={authorization.cancel}
          onChoose={(chatGPTAccountId) =>
            authorization.authorize({
              provider: 'openai',
              id: existingOAuth?.id ?? connection?.id,
              name: existingOAuth?.name ?? state.name.trim(),
              chatGPTAccountId,
            })
          }
        />
      )}
      <div
        className={cn('flex gap-x-4 empty:hidden', oauthConnect ? 'flex-col items-center' : 'flex-wrap justify-end')}
      >
        {provider === 'otari' && !state.customUrl && !existingSignIn && !state.editing && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="px-0 text-xs font-normal text-muted-foreground"
            disabled={state.busy}
            onClick={() => state.dispatch({ field: 'customUrl', value: true })}
          >
            <Trans>Custom URL</Trans>
          </Button>
        )}
        {state.definition.oauth &&
          !state.editing &&
          (connection ? state.authMethod === 'oauth' && onAddApiKey : provider !== 'openai' || canConnectChatGPT()) && (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="px-0 text-xs font-normal text-muted-foreground"
              disabled={state.busy}
              onClick={connection ? onAddApiKey : toggleAuthMethod}
            >
              {existingSignIn || connection ? (
                <Trans>Add another instance via API key</Trans>
              ) : state.authMethod === 'oauth' ? (
                <Trans>Use API Key instead</Trans>
              ) : (
                <Trans>Use sign-in instead</Trans>
              )}
            </Button>
          )}
      </div>
      {provider === 'openai' && !canConnectChatGPT() && !state.editing && (
        <p className="text-xs text-muted-foreground">
          <Trans>ChatGPT sign-in is available in the desktop app. You can use an OpenAI API key here.</Trans>
        </p>
      )}
      {(!oauthConnect || onBack) && (
        <FormFooter className={cn('w-full items-center', onBack && 'justify-between')}>
          {onBack ? (
            <BackButton onClick={onBack} disabled={state.busy && !oauthConnect} />
          ) : (
            <Button type="button" variant="outline" onClick={onCancel} disabled={state.busy}>
              <Trans>Cancel</Trans>
            </Button>
          )}
          <Button
            type="submit"
            isLoading={!oauthConnect && state.busy}
            disabled={oauthConnect || !state.valid || state.busy}
          >
            {state.editing ? (
              <Trans>Save Changes</Trans>
            ) : onBack ? (
              <Trans>Continue</Trans>
            ) : (
              <Trans>Save connection</Trans>
            )}
          </Button>
        </FormFooter>
      )}
    </form>
  )
}
