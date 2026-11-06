/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Link } from 'react-router'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Combobox } from '@/components/ui/combobox'
import { FormFooter } from '@/components/ui/form-footer'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getProviderDefinition } from '@/providers/registry'
import { getModelDisplayName } from './model-display-name'
import type { useAddProviderModels } from './use-add-provider-models'

/** Connection-first, searchable model selection without copying provider credentials. */
export const AddProviderModels = (state: ReturnType<typeof useAddProviderModels>) => {
  const { t } = useLingui()
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        state.submit()
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="model-provider-connection">
          <Trans>Connection</Trans>
        </Label>
        <Combobox
          id="model-provider-connection"
          items={state.connections.map((connection) => ({
            id: connection.id,
            label: connection.name,
            description: getProviderDefinition(connection.provider).name,
          }))}
          value={state.connectionId}
          onValueChange={state.changeConnection}
          placeholder={t`Choose a connection`}
          searchPlaceholder={t`Search connections…`}
          emptyMessage={t`No model providers connected.`}
          loading={state.isLoading}
          disabled={state.isPending}
        />
        <Link
          to="/settings/connections"
          onClick={state.onCancel}
          className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          <Trans>Manage connections</Trans>
        </Link>
      </div>
      {state.connection && !state.canLoad && (
        <p role="status" className="text-sm text-muted-foreground">
          {state.connection.connected ? (
            <Trans>Enable this connection to add models.</Trans>
          ) : (
            <Trans>Connect this provider on this device to add models.</Trans>
          )}
        </p>
      )}
      {state.canLoad && (
        <>
          {!state.manual && (
            <>
              <div className="flex items-center gap-2">
                <Input
                  value={state.search}
                  onChange={(event) => state.setSearch(event.target.value)}
                  placeholder={t`Search models…`}
                  aria-label={t`Search models`}
                  disabled={state.isPending}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  onClick={state.refresh}
                  disabled={state.isLoadingCatalog || state.isPending}
                  aria-label={t`Refresh models`}
                >
                  <RefreshCw className="size-4" />
                </Button>
              </div>
              {state.isLoadingCatalog ? (
                <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <Trans>Loading models…</Trans>
                </div>
              ) : state.catalogError ? (
                <p role="alert" className="text-sm text-destructive">
                  {state.catalogError}
                </p>
              ) : (
                <div role="group" aria-label={t`Models`} className="max-h-80 overflow-y-auto rounded-xl border p-2">
                  {state.visibleModels.length === 0 && (
                    <p className="p-3 text-sm text-muted-foreground">
                      <Trans>No models found.</Trans>
                    </p>
                  )}
                  {state.visibleModels.map((model) => {
                    const added = state.existingIds.has(model.id)
                    return (
                      <label
                        key={model.id}
                        className="flex cursor-pointer items-center gap-3 rounded-md p-3 hover:bg-accent"
                      >
                        <Checkbox
                          checked={added || state.selected.includes(model.id)}
                          onCheckedChange={() => state.toggleModel(model.id)}
                          disabled={added || state.isPending}
                          aria-label={getModelDisplayName(model)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{getModelDisplayName(model)}</span>
                          <span className="block truncate text-xs text-muted-foreground">{model.id}</span>
                        </span>
                        {added && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            <Trans>Added</Trans>
                          </span>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}
            </>
          )}
          {state.connection?.provider === 'custom' && (
            <>
              <Button
                type="button"
                variant="link"
                className="self-start px-0 text-muted-foreground"
                disabled={state.isPending}
                onClick={() => state.setManual(!state.manual)}
              >
                {state.manual ? <Trans>Choose from available models</Trans> : <Trans>Enter a model ID</Trans>}
              </Button>
              {state.manual && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="manual-provider-model">
                    <Trans>Model ID</Trans>
                  </Label>
                  <Input
                    id="manual-provider-model"
                    value={state.manualId}
                    onChange={(event) => state.setManualId(event.target.value)}
                    placeholder={t`e.g., llama3.3`}
                    disabled={state.isPending}
                  />
                  {state.existingIds.has(state.manualId.trim()) && (
                    <p className="text-sm text-muted-foreground">
                      <Trans>This model has already been added.</Trans>
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
      {state.submitError && (
        <p role="alert" className="text-sm text-destructive">
          {state.submitError}
        </p>
      )}
      <FormFooter>
        <Button type="button" variant="outline" onClick={state.onCancel} disabled={state.isPending}>
          <Trans>Cancel</Trans>
        </Button>
        <Button type="submit" disabled={!state.canSubmit} isLoading={state.isPending} loadingLabel={t`Adding…`}>
          <Trans>Add models</Trans>
        </Button>
      </FormFooter>
    </form>
  )
}
