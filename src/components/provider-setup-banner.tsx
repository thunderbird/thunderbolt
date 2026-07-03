/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Link } from 'react-router'
import { AlertTriangle } from 'lucide-react'
import { useProviders } from '@/dal'
import { useSettings } from '@/hooks/use-settings'

/**
 * Persistent "connect a provider" nag shown after the user skipped a provider
 * onboarding step without connecting one (spec-standalone §7–§8). Auto-hides
 * once any provider is connected (connecting clears `provider_setup_skipped`).
 */
export const ProviderSetupBanner = () => {
  const { providerSetupSkipped } = useSettings({ provider_setup_skipped: 'false' })
  const providers = useProviders()

  if (providerSetupSkipped.isLoading || providerSetupSkipped.value !== 'true' || providers.length > 0) {
    return null
  }

  return (
    <Link
      to="/settings/providers"
      className="flex items-center gap-2 px-4 py-2 text-[length:var(--font-size-sm)] bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 border-b border-amber-500/20"
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span>Connect a model or search provider to get the most out of Thunderbolt.</span>
      <span className="ml-auto underline">Set up providers</span>
    </Link>
  )
}
