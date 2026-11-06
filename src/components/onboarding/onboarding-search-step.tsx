/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans, useLingui } from '@lingui/react/macro'
import { Search } from 'lucide-react'
import { useId } from 'react'
import { SearchProviderSetup } from '@/components/search-provider-setup'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { canSupplySearch } from '@/integrations/standalone-search/eligibility'
import { useSearchProviderAvailability } from '@/integrations/standalone-search/use-search-provider-availability'
import { OnboardingStepHeader } from './onboarding-step-header'
import { useSearchProviderStore } from '@/stores/search-provider-store'

export const OnboardingSearchStep = ({ onReadyChange }: { onReadyChange?: (ready: boolean) => void }) => {
  const { t } = useLingui()
  const selectId = useId()
  const { connections } = useSearchProviderAvailability()
  const stored = useSearchProviderStore()
  const available = connections.filter(
    (connection) =>
      canSupplySearch(connection) &&
      (connection.provider !== 'otari' ||
        (stored.connectionStatus?.connectionId === connection.id && stored.connectionStatus.status === 'available')),
  )
  return (
    <div className="flex w-full flex-1 flex-col justify-center gap-8">
      <OnboardingStepHeader
        icon={<Search className="size-10 text-foreground/80" />}
        title={<Trans>Add web search</Trans>}
        description={<Trans>Optionally let your agent search the web</Trans>}
      />
      {stored.connectionStatus && stored.connectionStatus.status !== 'available' && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          <Trans>Otari web search isn’t available. Choose a search provider below, or skip for now.</Trans>
        </p>
      )}
      {available.length > 0 && (
        <div className="space-y-2">
          <Label htmlFor={selectId}>
            <Trans>Existing connection</Trans>
          </Label>
          <Select
            value={available.some(({ id }) => id === stored.connectionId) ? stored.connectionId! : ''}
            onValueChange={(id) => {
              stored.selectSearchConnection(id)
              onReadyChange?.(true)
            }}
          >
            <SelectTrigger id={selectId} className="w-full">
              <SelectValue placeholder={t`Choose a connection`} />
            </SelectTrigger>
            <SelectContent>
              {available.map((connection) => (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <SearchProviderSetup onReadyChange={onReadyChange} />
    </div>
  )
}
