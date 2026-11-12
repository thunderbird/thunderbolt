/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import type { SshEnvironment } from '@/agent-execution/ssh-environments'
import { SshFolderInput } from '@/components/ssh-environments'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useSshEnvironmentFormState } from './use-ssh-environment-form-state'

export const SshEnvironmentForm = ({
  environment,
  onSaved,
  onCancel,
}: {
  environment?: SshEnvironment
  onSaved: () => void
  onCancel: () => void
}) => {
  const { t } = useLingui()
  const state = useSshEnvironmentFormState(environment, onSaved)
  return (
    <form
      className="flex flex-1 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        state.submit()
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="ssh-name">
          <Trans>Name</Trans>
        </Label>
        <Input
          id="ssh-name"
          value={state.name}
          onChange={(event) => state.dispatch({ field: 'name', value: event.target.value })}
          disabled={state.pending}
          required
          autoFocus
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="ssh-host">
          <Trans>Host or SSH config alias</Trans>
        </Label>
        <Input
          id="ssh-host"
          value={state.host}
          onChange={(event) => state.dispatch({ field: 'host', value: event.target.value })}
          disabled={state.pending}
          required
          placeholder={t`For example, orb or server.example.com`}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="ssh-username">
            <Trans>Username</Trans>
          </Label>
          <Input
            id="ssh-username"
            value={state.username}
            onChange={(event) => state.dispatch({ field: 'username', value: event.target.value })}
            disabled={state.pending}
            placeholder={t`From SSH config`}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="ssh-port">
            <Trans>Port</Trans>
          </Label>
          <Input
            id="ssh-port"
            type="number"
            min={1}
            max={65535}
            value={state.port}
            onChange={(event) => state.dispatch({ field: 'port', value: event.target.value })}
            disabled={state.pending}
            placeholder={t`From SSH config`}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="ssh-authentication">
          <Trans>Authentication</Trans>
        </Label>
        <Select
          value={state.authentication}
          onValueChange={(value: SshEnvironment['authentication']) =>
            state.dispatch({ field: 'authentication', value })
          }
          disabled={state.pending}
        >
          <SelectTrigger id="ssh-authentication" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="agent">
              <Trans>SSH config and agent</Trans>
            </SelectItem>
            <SelectItem value="key">
              <Trans>Private key file</Trans>
            </SelectItem>
            <SelectItem value="password">
              <Trans>Password</Trans>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {state.authentication === 'key' && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="ssh-identity">
            <Trans>Private key file</Trans>
          </Label>
          <Input
            id="ssh-identity"
            value={state.identityFile}
            onChange={(event) => state.dispatch({ field: 'identityFile', value: event.target.value })}
            disabled={state.pending}
            required
            placeholder={t`Path to a private key on this computer`}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
      {state.authentication !== 'agent' && (
        <div className="flex flex-col gap-2">
          <Label htmlFor="ssh-secret">
            {state.authentication === 'password' ? <Trans>Password</Trans> : <Trans>Key passphrase (optional)</Trans>}
          </Label>
          <Input
            id="ssh-secret"
            type="password"
            value={state.secret}
            onChange={(event) => state.dispatch({ field: 'secret', value: event.target.value })}
            disabled={state.pending || state.clearSavedSecret}
            required={state.secretRequired}
            autoComplete="new-password"
            placeholder={
              environment && !state.connectionChanged && !state.clearSavedSecret
                ? t`Leave blank to keep the saved credential`
                : undefined
            }
          />
          <p className="text-xs text-muted-foreground">
            <Trans>Saved in this computer's secure credential store. Never synced.</Trans>
          </p>
          {environment?.hasSecret && environment.authentication === 'key' && state.authentication === 'key' && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={state.clearSavedSecret}
                onCheckedChange={(checked) => {
                  state.dispatch({ field: 'clearSavedSecret', value: checked === true })
                  state.dispatch({ field: 'secret', value: '' })
                }}
                disabled={state.pending}
              />
              <Trans>Remove saved passphrase</Trans>
            </label>
          )}
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="ssh-cwd">
          <Trans>Working folder</Trans>
        </Label>
        {environment && !state.connectionChanged && !state.secret && !state.clearSavedSecret ? (
          <SshFolderInput
            id="ssh-cwd"
            environmentId={environment.id}
            value={state.cwd}
            onChange={(value) => state.dispatch({ field: 'cwd', value })}
            disabled={state.pending}
          />
        ) : (
          <Input
            id="ssh-cwd"
            value={state.cwd}
            onChange={(event) => state.dispatch({ field: 'cwd', value: event.target.value })}
            disabled={state.pending}
            required
            autoComplete="off"
            spellCheck={false}
          />
        )}
        <p className="text-xs text-muted-foreground">
          <Trans>An existing folder on the remote machine. Use ~ for its home folder.</Trans>
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        <Trans>
          Connect once from your terminal to verify the host key. The remote machine needs Linux or macOS with Python 3
          and Bash.
        </Trans>
      </p>
      {state.error && (
        <div role="alert" className="text-sm text-destructive">
          <p>{state.error}</p>
          {state.errorDetail && (
            <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-xs">{state.errorDetail}</pre>
          )}
        </div>
      )}
      <FormFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={state.pending}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!state.valid || state.pending} isLoading={state.pending}>
          <Trans>Save</Trans>
        </Button>
      </FormFooter>
    </form>
  )
}
