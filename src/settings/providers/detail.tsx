/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/page-header'
import { StatusCard } from '@/components/ui/status-card'
import { Switch } from '@/components/ui/switch'
import { useDatabase } from '@/contexts'
import { deleteProvider, useProviders, type Provider } from '@/dal'
import { useActiveWorkspaceId, useWorkspaceNavigate } from '@/lib/active-workspace'
import { useMutation } from '@tanstack/react-query'
import { ArrowLeft, Loader2, Search } from 'lucide-react'
import { useParams } from 'react-router'
import { providerDisplayLabel } from './provider-helpers'
import { useProviderDetailState } from './use-provider-detail-state'

const ProviderDetail = ({ provider }: { provider: Provider }) => {
  const db = useDatabase()
  const workspaceId = useActiveWorkspaceId()
  const workspaceNavigate = useWorkspaceNavigate()
  const {
    def,
    search,
    setSearch,
    catalog,
    filteredModels,
    enabledModelIds,
    enabledCapabilities,
    isActiveSearchProvider,
    toggleModel,
    toggleCapability,
    setActiveSearchProvider,
  } = useProviderDetailState(provider)

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      if (!workspaceId) {
        throw new Error('No active workspace')
      }
      await deleteProvider(db, workspaceId, provider.id)
    },
    onSuccess: () => workspaceNavigate('/settings/providers'),
  })

  const offersBothCapabilities = def.capabilities.length > 1
  const isSearchCapable = def.capabilities.includes('search')
  const isModelsCapable = def.capabilities.includes('models')

  return (
    <div className="max-w-[760px] mx-auto p-4 pb-12 flex flex-col gap-6">
      <Button
        variant="ghost"
        size="sm"
        className="self-start -ml-2"
        onClick={() => workspaceNavigate('/settings/providers')}
      >
        <ArrowLeft className="size-4 mr-1" />
        Providers
      </Button>

      <PageHeader title={providerDisplayLabel(provider)}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => disconnectMutation.mutate()}
          disabled={disconnectMutation.isPending}
        >
          Disconnect
        </Button>
      </PageHeader>

      <Card className="border border-border">
        <CardHeader className="py-3">
          <CardTitle className="text-base">Connection</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 border-t pt-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Provider</span>
            <span className="text-sm">{def.name}</span>
          </div>
          {provider.baseUrl && (
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Base URL</span>
              <span className="text-sm font-mono truncate max-w-[300px]">{provider.baseUrl}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {offersBothCapabilities && (
        <Card className="border border-border">
          <CardHeader className="py-3">
            <CardTitle className="text-base">Capabilities</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 border-t pt-4">
            {def.capabilities.map((capability) => (
              <div key={capability} className="flex items-center justify-between">
                <span className="text-sm capitalize">{capability}</span>
                <Switch
                  checked={enabledCapabilities.includes(capability)}
                  onCheckedChange={() => toggleCapability(capability)}
                />
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {isSearchCapable && enabledCapabilities.includes('search') && (
        <Card className="border border-border">
          <CardHeader className="grid grid-cols-[1fr_auto] items-center gap-x-4 py-3">
            <CardTitle className="text-base">Search</CardTitle>
            <Button variant="outline" size="sm" onClick={setActiveSearchProvider} disabled={isActiveSearchProvider}>
              {isActiveSearchProvider ? 'Active search provider' : 'Set as active search provider'}
            </Button>
          </CardHeader>
        </Card>
      )}

      {isModelsCapable && enabledCapabilities.includes('models') && (
        <div className="flex flex-col gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search models..."
              className="pl-9 rounded-lg"
            />
          </div>

          {catalog.isLoading && (
            <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading models...
            </div>
          )}

          {catalog.isError && (
            <StatusCard
              title="Couldn't load models"
              description={
                catalog.error instanceof Error ? catalog.error.message : 'Failed to fetch the model catalog.'
              }
              className="bg-red-50/50 dark:bg-red-500/10 border-red-200/50 dark:border-red-500/20"
            />
          )}

          {!catalog.isLoading && !catalog.isError && (
            <div className="grid gap-2">
              {filteredModels.map((model) => (
                <Card key={model.id} className="border border-border">
                  <CardHeader className="grid grid-cols-[1fr_auto] items-center gap-x-4 py-2">
                    <div className="min-w-0">
                      <CardTitle className="text-sm font-medium truncate">{model.name ?? model.id}</CardTitle>
                      {model.name && (
                        <p className="text-[length:var(--font-size-xs)] text-muted-foreground truncate">{model.id}</p>
                      )}
                    </div>
                    <Switch
                      checked={enabledModelIds.has(model.id)}
                      onCheckedChange={(checked) => toggleModel(model, checked)}
                    />
                  </CardHeader>
                </Card>
              ))}
              {filteredModels.length === 0 && (
                <p className="text-sm text-muted-foreground py-8 text-center">No models match your search.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function ProviderDetailPage() {
  const { providerId } = useParams<{ providerId: string }>()
  const workspaceNavigate = useWorkspaceNavigate()
  const providers = useProviders()
  const provider = providers.find((item) => item.id === providerId)

  if (!provider) {
    return (
      <div className="max-w-[760px] mx-auto p-4 pb-12 flex flex-col gap-4">
        <Button
          variant="ghost"
          size="sm"
          className="self-start -ml-2"
          onClick={() => workspaceNavigate('/settings/providers')}
        >
          <ArrowLeft className="size-4 mr-1" />
          Providers
        </Button>
        <p className="text-sm text-muted-foreground">This provider is no longer connected.</p>
      </div>
    )
  }

  return <ProviderDetail provider={provider} />
}
