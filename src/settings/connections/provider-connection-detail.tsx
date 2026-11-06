/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useState } from 'react'
import { Link } from 'react-router'
import { Trans } from '@lingui/react/macro'
import { DetailPanel } from '@/components/detail-panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getProviderDefinition } from '@/providers/registry'
import type { ProviderConnection } from '@/providers/types'
import type { useProviderAuthorization } from '@/providers/use-provider-authorization'
import { ProviderConnectionIcon } from './provider-connection-icon'
import { ProviderConnectionForm } from './provider-connection-form'
import type { useAiProviderConnections } from './use-ai-provider-connections'
import { openExternalUrl } from '@/lib/open-external-url'
import { tinfoilManageSubscriptionUrl } from '@/lib/tinfoil-auth'

/** A durable connection stays visible when this device has no credentials. */
export const ProviderConnectionDetail = ({
  connection,
  controls,
  authorization,
  onClose,
}: {
  connection: ProviderConnection
  controls: ReturnType<typeof useAiProviderConnections>
  authorization: ReturnType<typeof useProviderAuthorization>
  onClose: () => void
}) => {
  const [name, setName] = useState(connection.name)
  const [editingCredentials, setEditingCredentials] = useState(false)
  const definition = getProviderDefinition(connection.provider)
  const showForm = !connection.connected || editingCredentials
  return (
    <DetailPanel
      title={connection.name}
      subtitle={definition.name}
      icon={<ProviderConnectionIcon provider={connection.provider} />}
      onClose={onClose}
    >
      {showForm ? (
        <>
          {!connection.connected && (
            <p className="text-sm text-muted-foreground">
              <Trans>Connect on this device</Trans>
            </p>
          )}
          <ProviderConnectionForm
            provider={connection.provider}
            connection={connection}
            authorization={authorization}
            onSaved={() => setEditingCredentials(false)}
            onCancel={() => (editingCredentials ? setEditingCredentials(false) : onClose())}
          />
        </>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {connection.enabled ? <Trans>Connected</Trans> : <Trans>Connection disabled</Trans>}
          </p>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              controls.rename(connection.id, name.trim())
            }}
          >
            <Label htmlFor="saved-connection-name">
              <Trans>Name</Trans>
            </Label>
            <Input
              id="saved-connection-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              disabled={controls.pending}
            />
            <Button
              type="submit"
              variant="outline"
              className="self-start"
              disabled={!name.trim() || name.trim() === connection.name || controls.pending}
            >
              <Trans>Save name</Trans>
            </Button>
          </form>
          {connection.url && <p className="break-all text-sm text-muted-foreground">{connection.url}</p>}
          <div className="flex flex-wrap gap-2">
            {connection.authMethod === 'api_key' && (
              <Button variant="outline" onClick={() => setEditingCredentials(true)} disabled={controls.pending}>
                <Trans>Update credentials</Trans>
              </Button>
            )}
            <Button variant="outline" onClick={() => controls.disconnect(connection.id)} disabled={controls.pending}>
              <Trans>Disconnect this device</Trans>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            <Trans>Disconnecting keeps your models and connection settings.</Trans>
          </p>
          {connection.provider === 'tinfoil' && connection.authMethod === 'oauth' && (
            <Button
              variant="link"
              className="self-start px-0"
              onClick={() => openExternalUrl(tinfoilManageSubscriptionUrl)}
            >
              <Trans>Manage subscription</Trans>
            </Button>
          )}
          {definition.capabilities.includes('models') && (
            <Button asChild variant="outline">
              <Link to="/settings/models">
                <Trans>Manage models</Trans>
              </Link>
            </Button>
          )}
          {definition.capabilities.includes('search') && (
            <Button asChild variant="outline">
              <Link to="/settings/search">
                <Trans>Search settings</Trans>
              </Link>
            </Button>
          )}
        </div>
      )}
      {controls.error && (
        <p role="alert" className="text-sm text-destructive">
          {controls.error}
        </p>
      )}
    </DetailPanel>
  )
}
