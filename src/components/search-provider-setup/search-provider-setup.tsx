/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useId } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isSearchProvider, searchProviders, type SearchProvider } from '@/integrations/standalone-search/providers'
import { useSearchProviderSetup } from './use-search-provider-setup'

type Props = {
  provider?: SearchProvider
  onSaved?: () => void
  onReadyChange?: (ready: boolean) => void
  testConnection?: Parameters<typeof useSearchProviderSetup>[2]
}

/** Device-local search configuration shared by onboarding and Settings. */
export const SearchProviderSetup = ({ onSaved, onReadyChange, testConnection, provider: fixedProvider }: Props) => {
  const { t } = useLingui()
  const inputId = useId()
  const providerId = useId()
  const state = useSearchProviderSetup(onReadyChange, onSaved, testConnection, fixedProvider)
  const provider = state.provider ? searchProviders[state.provider] : null
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void state.test()
      }}
      className="space-y-4"
    >
      {!fixedProvider && (
        <div className="space-y-2">
          <Label htmlFor={providerId}>
            <Trans>Search provider</Trans>
          </Label>
          <Select
            value={state.provider ?? ''}
            onValueChange={(value) => {
              if (isSearchProvider(value)) {
                state.change({ provider: value, apiKey: '' })
              }
            }}
          >
            <SelectTrigger id={providerId} className="w-full">
              <SelectValue placeholder={t`Choose a provider`} />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(searchProviders).map(([id, item]) => (
                <SelectItem key={id} value={id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {provider && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={inputId}>
                <Trans>API key</Trans>
              </Label>
              <a
                href={provider.keyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline underline-offset-4"
              >
                <Trans>Get an API key</Trans>
              </a>
            </div>
            <Input
              id={inputId}
              type="password"
              autoComplete="off"
              value={state.apiKey}
              onChange={(event) => state.change({ apiKey: event.target.value })}
              placeholder={t`Enter your API key`}
            />
            <p className="text-xs text-muted-foreground">
              <Trans>Your API key stays on this device.</Trans>
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              {state.status === 'success' && (
                <>
                  <Check className="size-4 text-green-600" />
                  <Trans>Connected</Trans>
                </>
              )}
            </div>
            <div className="flex gap-2">
              {state.hasSavedKey && (
                <Button type="button" variant="ghost" onClick={state.disconnect}>
                  <Trans>Disconnect</Trans>
                </Button>
              )}
              {state.status !== 'success' && (
                <Button type="submit" variant="outline" disabled={!state.apiKey.trim() || state.status === 'testing'}>
                  {state.status === 'testing' ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      <Trans>Testing…</Trans>
                    </>
                  ) : (
                    <Trans>Test connection</Trans>
                  )}
                </Button>
              )}
            </div>
          </div>
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
        </>
      )}
    </form>
  )
}
