/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useServerConnectionState } from './use-server-connection-state'

type ServerConnectionFormProps = {
  onConnected?: () => void
  submitLabel?: string
}

/** Shared server selection used by onboarding and cloud feature entry points. */
export const ServerConnectionForm = ({ onConnected, submitLabel }: ServerConnectionFormProps) => {
  const { t } = useLingui()
  const inputId = useId()
  const errorId = `${inputId}-error`
  const { serverUrl, setServerUrl, error, isConnecting, submit } = useServerConnectionState(onConnected)

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId}>
          <Trans>Thunderbolt server address</Trans>
        </Label>
        <Input
          id={inputId}
          value={serverUrl}
          onChange={(event) => setServerUrl(event.target.value)}
          placeholder={t`https://your-server.example`}
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          disabled={isConnecting}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      {error && (
        <p id={errorId} className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={isConnecting || !serverUrl.trim()} aria-busy={isConnecting}>
        {isConnecting ? t`Connecting…` : (submitLabel ?? t`Connect to server`)}
      </Button>
    </form>
  )
}
