/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import {
  ResponsiveModalContentComposable,
  ResponsiveModalDescription,
  ResponsiveModalHeader,
  ResponsiveModalTitle,
} from '@/components/ui/responsive-modal'
import { StatusCard } from '@/components/ui/status-card'
import { ScopePicker } from '@/components/scope-picker'
import { ScopeBadge } from '@/components/scope-badge'
import { useScopePickerEnabled } from '@/hooks/use-scope-picker-enabled'
import { useDatabase } from '@/contexts'
import { deleteProvider, useProviders, type Provider } from '@/dal'
import { useActiveWorkspaceId, useWorkspaceNavigate } from '@/lib/active-workspace'
import { isTauri } from '@/lib/platform'
import {
  getProviderDefinition,
  providerNeedsCredential,
  type ProviderCapability,
  type ProviderType,
} from '@shared/providers'
import { useMutation } from '@tanstack/react-query'
import { Check, Loader2, Plug, X } from 'lucide-react'
import { useMemo } from 'react'
import { buildConnectTargets, providerDisplayLabel, providerEnabledCapabilities } from './provider-helpers'
import { useConnectProvider } from './use-connect-provider'

const CapabilityBadge = ({ capability }: { capability: ProviderCapability }) => (
  <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[length:var(--font-size-xs)] font-medium capitalize text-muted-foreground">
    {capability === 'models' ? 'Models' : 'Search'}
  </span>
)

const ConnectedProviderCard = ({
  provider,
  onOpen,
  onDisconnect,
  disconnecting,
  showScope,
}: {
  provider: Provider
  onOpen: () => void
  onDisconnect: () => void
  disconnecting: boolean
  showScope: boolean
}) => (
  <Card className="border border-border">
    <CardHeader className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0 py-2">
      <button type="button" onClick={onOpen} className="flex flex-col items-start gap-1 text-left cursor-pointer">
        <CardTitle className="text-base">{providerDisplayLabel(provider)}</CardTitle>
        <div className="flex items-center gap-2">
          {providerEnabledCapabilities(provider).map((capability) => (
            <CapabilityBadge key={capability} capability={capability} />
          ))}
          <ScopeBadge scope={provider.scope} show={showScope} />
        </div>
      </button>
      <CardAction className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onOpen}>
          Manage
        </Button>
        <Button variant="outline" size="sm" onClick={onDisconnect} disabled={disconnecting}>
          Disconnect
        </Button>
      </CardAction>
    </CardHeader>
  </Card>
)

const ConnectTargetCard = ({ type, onConnect }: { type: ProviderType; onConnect: () => void }) => {
  const def = getProviderDefinition(type)
  return (
    <Card className="border border-border">
      <CardHeader className="grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0 py-2">
        <div className="flex flex-col items-start gap-1">
          <CardTitle className="text-base">{def.name}</CardTitle>
          <div className="flex items-center gap-2">
            {def.capabilities.map((capability) => (
              <CapabilityBadge key={capability} capability={capability} />
            ))}
          </div>
        </div>
        <CardAction>
          {def.comingSoon ? (
            <Button variant="outline" size="sm" disabled>
              Coming soon
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onConnect}>
              Connect
            </Button>
          )}
        </CardAction>
      </CardHeader>
    </Card>
  )
}

const ConnectDialog = ({
  connect,
  scopeEnabled,
}: {
  connect: ReturnType<typeof useConnectProvider>
  scopeEnabled: boolean
}) => {
  const { state, close, setApiKey, setBaseUrl, setScope, submit } = connect
  if (!state.type) {
    return null
  }
  const def = getProviderDefinition(state.type)
  const isOauth = def.connectionType === 'oauth-pkce'
  const oauthUnsupported = isOauth && !isTauri()
  const showBaseUrl = def.connectionType === 'url' && def.requiresBaseUrl === true
  const showApiKey =
    def.connectionType === 'api-key' || (def.connectionType === 'url' && providerNeedsCredential(state.type))
  const connecting = state.status === 'connecting'

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <ResponsiveModalContentComposable className="sm:max-w-[500px]">
        <ResponsiveModalHeader>
          <ResponsiveModalTitle>Connect {def.name}</ResponsiveModalTitle>
          <ResponsiveModalDescription className="sr-only">Connect a {def.name} account</ResponsiveModalDescription>
        </ResponsiveModalHeader>

        <div className="grid gap-4 pt-4 pb-2">
          {scopeEnabled && <ScopePicker id="connect-provider-scope" value={state.scope} onChange={setScope} />}

          {oauthUnsupported && (
            <StatusCard
              title="Desktop only for now"
              description="OpenRouter sign-in runs a local callback and is available in the Thunderbolt desktop app."
            />
          )}

          {showBaseUrl && (
            <div className="grid gap-2">
              <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor="connect-base-url">
                Base URL
              </label>
              <Input
                id="connect-base-url"
                value={state.baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={def.defaultBaseUrl}
                className="rounded-lg"
              />
            </div>
          )}

          {showApiKey && (
            <div className="grid gap-2">
              <label className="text-[length:var(--font-size-sm)] font-medium" htmlFor="connect-api-key">
                API Key{def.connectionType === 'url' ? ' (optional)' : ''}
              </label>
              <Input
                id="connect-api-key"
                type="password"
                value={state.apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                className="rounded-lg"
              />
            </div>
          )}

          {state.status === 'success' && (
            <StatusCard
              title={
                <>
                  <Check className="h-5 w-5 text-green-600" />
                  Connected
                </>
              }
              description="The connection test succeeded."
              className="border-green-200/50 dark:border-green-500/20"
            />
          )}

          {state.status === 'error' && state.error && (
            <StatusCard
              title={
                <>
                  <X className="h-5 w-5 text-red-600" />
                  Connection failed
                </>
              }
              description={state.error}
              className="bg-red-50/50 dark:bg-red-500/10 border-red-200/50 dark:border-red-500/20"
            />
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={close}>
              {state.status === 'success' ? 'Done' : 'Cancel'}
            </Button>
            {state.status !== 'success' && (
              <Button type="button" onClick={submit} disabled={connecting || oauthUnsupported}>
                {connecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {isOauth ? 'Sign in' : 'Connect'}
              </Button>
            )}
          </div>
        </div>
      </ResponsiveModalContentComposable>
    </Dialog>
  )
}

export default function ProvidersPage() {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const workspaceNavigate = useWorkspaceNavigate()
  const scopeEnabled = useScopePickerEnabled()
  const providers = useProviders()
  const connect = useConnectProvider()

  const connectTargets = useMemo(
    () => buildConnectTargets(new Set(providers.map((provider) => provider.type as ProviderType))),
    [providers],
  )

  const disconnectMutation = useMutation({
    mutationFn: async (id: string) => {
      if (!workspaceId) {
        throw new Error('No active workspace')
      }
      await deleteProvider(db, workspaceId, id)
    },
  })

  return (
    <div className="max-w-[760px] mx-auto p-4 pb-12 flex flex-col gap-6">
      <PageHeader title="Providers" />

      {providers.length > 0 && (
        <div className="grid gap-4">
          <h2 className="text-[length:var(--font-size-sm)] font-medium text-muted-foreground">Connected</h2>
          {providers.map((provider) => (
            <ConnectedProviderCard
              key={provider.id}
              provider={provider}
              onOpen={() => workspaceNavigate(`/settings/providers/${provider.id}`)}
              onDisconnect={() => disconnectMutation.mutate(provider.id)}
              disconnecting={disconnectMutation.isPending}
              showScope={scopeEnabled}
            />
          ))}
        </div>
      )}

      <div className="grid gap-4">
        <h2 className="text-[length:var(--font-size-sm)] font-medium text-muted-foreground">Available</h2>
        {connectTargets.map((type) => (
          <ConnectTargetCard key={type} type={type} onConnect={() => connect.open(type)} />
        ))}
        {connectTargets.length === 0 && (
          <Card className="border-dashed border-2 border-muted-foreground/25 shadow-none">
            <CardContent className="flex flex-col items-center justify-center py-8 text-center">
              <Plug className="size-8 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">Every available provider is connected.</p>
            </CardContent>
          </Card>
        )}
      </div>

      <ConnectDialog connect={connect} scopeEnabled={scopeEnabled} />
    </div>
  )
}
