/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { Search } from 'lucide-react'
import { SearchProviderSetup } from '@/components/search-provider-setup'
import { OnboardingStepHeader } from './onboarding-step-header'

export const OnboardingSearchStep = ({ onReadyChange }: { onReadyChange?: (ready: boolean) => void }) => (
  <div className="flex w-full flex-1 flex-col justify-center gap-8">
    <OnboardingStepHeader
      icon={<Search className="size-10 text-foreground/80" />}
      title={<Trans>Add web search</Trans>}
      description={<Trans>Optionally let your agent search the web</Trans>}
    />
    <SearchProviderSetup onReadyChange={onReadyChange} />
  </div>
)
