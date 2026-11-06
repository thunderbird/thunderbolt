/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProviderConnectionButton } from '@/components/provider-connection-button'
import type { ProviderConnection, ProviderType } from '@/providers/types'
import type { useProviderAuthorization } from '@/providers/use-provider-authorization'
import { useProviderConnectionForm } from './use-provider-connection-form'

/** Adds a named OAuth or API-key connection without requiring a model. */
export const ProviderConnectionForm = ({
  provider,
  connection,
  existingOAuth,
  authorization,
  onSaved,
  onCancel,
}: {
  provider: ProviderType
  connection?: ProviderConnection
  existingOAuth?: ProviderConnection
  authorization: ReturnType<typeof useProviderAuthorization>
  onSaved: (id: string) => void
  onCancel: () => void
}) => {
  const { t } = useLingui()
  const state = useProviderConnectionForm({ provider, connection, authorization, onSaved })
  const name = state.definition.name
  const existingSignIn = !connection && state.authMethod === 'oauth' ? existingOAuth : undefined
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        if (existingSignIn) {
          onSaved(existingSignIn.id)
        } else {
          state.submit()
        }
      }}
      className="flex flex-col gap-4"
    >
      {!existingSignIn && (
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
          />
        </div>
      )}
      {state.definition.oauth && !connection && (
        <fieldset className="flex gap-4" disabled={state.busy}>
          <legend className="mb-2 text-sm font-medium">
            <Trans>Connect with</Trans>
          </legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="connection-auth"
              checked={state.authMethod === 'oauth'}
              onChange={() => state.dispatch({ field: 'authMethod', value: 'oauth' })}
            />
            <Trans>Sign in</Trans>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="connection-auth"
              checked={state.authMethod === 'api_key'}
              onChange={() => state.dispatch({ field: 'authMethod', value: 'api_key' })}
            />
            <Trans>API key</Trans>
          </label>
        </fieldset>
      )}
      {existingSignIn && (
        <p className="text-sm text-muted-foreground">
          <Trans>
            A sign-in connection already exists for {name}. Open it to manage this account, or use an API key for
            another connection.
          </Trans>
        </p>
      )}
      {!existingSignIn && state.definition.requiresUrl && (provider !== 'otari' || state.customUrl) && (
        <div className="flex flex-col gap-2">
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
            disabled={state.busy}
            autoComplete="url"
            autoFocus={provider === 'otari'}
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
            required={provider !== 'custom'}
            disabled={state.busy}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
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
      <FormFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            authorization.cancel()
            onCancel()
          }}
          disabled={state.busy && !authorization.isPending}
        >
          <Trans>Cancel</Trans>
        </Button>
        {existingSignIn ? (
          <Button type="button" onClick={() => onSaved(existingSignIn.id)}>
            <Trans>Open {existingSignIn.name}</Trans>
          </Button>
        ) : state.authMethod === 'oauth' ? (
          <ProviderConnectionButton
            isConnected={false}
            isProcessing={authorization.isPending}
            connectLabel={t`Connect ${name}`}
            onConnect={state.submit}
            onCancel={authorization.cancel}
            disabled={!state.valid && !authorization.isPending}
          />
        ) : (
          <Button type="submit" isLoading={state.busy} disabled={!state.valid || state.busy}>
            <Trans>Save connection</Trans>
          </Button>
        )}
      </FormFooter>
      {provider === 'otari' && !state.customUrl && !existingSignIn && (
        <Button
          type="button"
          variant="link"
          className="self-center text-muted-foreground"
          disabled={state.busy}
          onClick={() => state.dispatch({ field: 'customUrl', value: true })}
        >
          <Trans>Custom URL</Trans>
        </Button>
      )}
    </form>
  )
}
