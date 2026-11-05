/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Search } from 'lucide-react'
import { SearchProviderSetup } from '@/components/search-provider-setup'
import { OnboardingStepHeader } from './onboarding-step-header'
import { useSearchProviderStore } from '@/stores/search-provider-store'

export const OnboardingSearchStep = ({ onReadyChange }: { onReadyChange?: (ready: boolean) => void }) => {
  const otari = useSearchProviderStore((state) => state.otariConnection)
  return (
    <div className="flex w-full flex-1 flex-col justify-center gap-8">
      <OnboardingStepHeader
        icon={<Search className="size-10 text-foreground/80" />}
        title={<Trans>Add web search</Trans>}
        description={<Trans>Optionally let your agent search the web</Trans>}
      />
      {otari && otari.searchStatus !== 'available' && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          <Trans>Otari web search isn’t available. Choose a search provider below, or skip for now.</Trans>
        </p>
      )}
      <SearchProviderSetup onReadyChange={onReadyChange} />
    </div>
  )
}
