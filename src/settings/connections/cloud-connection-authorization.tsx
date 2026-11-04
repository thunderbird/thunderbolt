/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { CloudError, CloudField } from '@/components/cloud-agent/common'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

import {
  useCloudConnectionAuthorizationState,
  type CloudConnectionAuthorizationProps,
} from './use-cloud-connection-authorization-state'

/** Edit only cloud authorization; names/endpoints are supplied by the existing library definition. */
export const CloudConnectionAuthorization = (props: CloudConnectionAuthorizationProps) => {
  const { connection, source, available } = props
  const { t } = useLingui()
  const { draft, patch, changedEndpoint, save, toggle, test, oauth, busy, limits, limit } =
    useCloudConnectionAuthorizationState(props)
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        <Trans>
          Cloud agents use this library connection with separate authorization. Credentials saved on this device are
          never copied automatically.
        </Trans>
      </p>
      {!available && (
        <p className="text-sm text-muted-foreground">
          <Trans>Cloud execution is not available on this server.</Trans>
        </p>
      )}
      {connection && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">
            {connection.record.status === 'ready'
              ? t`Cloud connection ready`
              : connection.record.status === 'needs-authorization'
                ? t`Cloud authorization required`
                : connection.record.status === 'unreachable'
                  ? t`Cloud connection unreachable`
                  : t`Cloud connection not tested`}
          </span>
          <Switch
            aria-label={t`Allow cloud use`}
            checked={connection.record.enabled}
            onCheckedChange={() => toggle.mutate()}
            disabled={busy || save.hasPrepared || !available}
          />
        </div>
      )}
      {changedEndpoint && (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>
            The library endpoint changed. Save a new cloud authorization before using this connection in cloud agents.
          </Trans>
        </p>
      )}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate()
        }}
      >
        <fieldset disabled={!available || busy || save.hasPrepared} className="flex flex-col gap-3">
          <CloudField label={<Trans>Cloud authentication</Trans>}>
            <Select
              value={draft.authentication.type}
              onValueChange={(type) => {
                if (type === 'none') {
                  patch({ authentication: { type: 'none' } })
                }
                if (type === 'bearer') {
                  patch({ authentication: { type: 'bearer', token: '' } })
                }
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  <Trans>No authentication</Trans>
                </SelectItem>
                <SelectItem value="bearer">
                  <Trans>API key or bearer token</Trans>
                </SelectItem>
                {draft.authentication.type === 'oauth' && (
                  <SelectItem value="oauth">
                    <Trans>OAuth</Trans>
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </CloudField>
          {draft.authentication.type === 'bearer' && (
            <CloudField label={<Trans>Cloud credential</Trans>}>
              <Input
                type="password"
                autoComplete="new-password"
                value={draft.authentication.token}
                onChange={(event) => patch({ authentication: { type: 'bearer', token: event.target.value } })}
                required
              />
            </CloudField>
          )}
          {source.kind === 'mcp' && (
            <CloudField label={<Trans>Allowed tools (optional)</Trans>}>
              <Textarea
                rows={3}
                value={draft.allowedTools?.join('\n') ?? ''}
                placeholder={t`One tool name per line. Leave blank to use all available tools.`}
                onChange={(event) =>
                  patch({
                    allowedTools: event.target.value.trim()
                      ? event.target.value
                          .split('\n')
                          .map((name) => name.trim())
                          .filter(Boolean)
                      : undefined,
                  })
                }
              />
            </CloudField>
          )}
          {source.kind === 'model' && limits && (
            <>
              <CloudField label={<Trans>Context window</Trans>}>
                <Input
                  type="number"
                  min="1"
                  required
                  value={limits.contextWindow}
                  onChange={(event) => limit('contextWindow', event.target.value)}
                />
              </CloudField>
              <CloudField label={<Trans>Maximum output tokens</Trans>}>
                <Input
                  type="number"
                  min="1"
                  required
                  value={limits.maxOutputTokens}
                  onChange={(event) => limit('maxOutputTokens', event.target.value)}
                />
              </CloudField>
              <CloudField label={<Trans>Input cost per million tokens (USD)</Trans>}>
                <Input
                  type="number"
                  min="0.000000001"
                  step="any"
                  required
                  value={limits.inputCostPerMillion || ''}
                  onChange={(event) => limit('inputCostPerMillion', event.target.value)}
                />
              </CloudField>
              <CloudField label={<Trans>Output cost per million tokens (USD)</Trans>}>
                <Input
                  type="number"
                  min="0.000000001"
                  step="any"
                  required
                  value={limits.outputCostPerMillion || ''}
                  onChange={(event) => limit('outputCostPerMillion', event.target.value)}
                />
              </CloudField>
              <p className="text-sm text-muted-foreground">
                <Trans>Use your provider’s current limits and prices for cloud run budgets.</Trans>
              </p>
            </>
          )}
        </fieldset>
        <CloudError error={save.error ?? toggle.error ?? test.error ?? oauth.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={!available || busy}>
            {save.hasPrepared ? (
              <Trans>Retry save</Trans>
            ) : connection ? (
              <Trans>Save cloud authorization</Trans>
            ) : (
              <Trans>Authorize cloud use</Trans>
            )}
          </Button>
          {connection && !changedEndpoint && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || save.hasPrepared || !connection.record.enabled || !available}
              onClick={() => test.mutate()}
            >
              <Trans>Test cloud connection</Trans>
            </Button>
          )}
          {connection &&
            !changedEndpoint &&
            source.kind === 'mcp' &&
            connection.config.authentication.type !== 'bearer' && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy || save.hasPrepared || !connection.record.enabled || !available}
                onClick={() => oauth.mutate()}
              >
                {connection.config.authentication.type === 'oauth' ? (
                  <Trans>Reconnect cloud OAuth</Trans>
                ) : (
                  <Trans>Connect cloud OAuth</Trans>
                )}
              </Button>
            )}
        </div>
      </form>
      {oauth.data && (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Finish authorizing this connection in your browser.</Trans>{' '}
          <a className="underline" href={oauth.data.authorizationUrl} target="_blank" rel="noopener noreferrer">
            <Trans>Continue authorization</Trans>
          </a>
        </p>
      )}
    </div>
  )
}
