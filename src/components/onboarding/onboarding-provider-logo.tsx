/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import openRouterLogo from '@/assets/openrouter.svg'
import otariLogo from '@/assets/otari.svg'
import tinfoilLogo from '@/assets/tinfoil.svg'
import { cn } from '@/lib/utils'
import type { OnboardingProvider } from './provider-default-model'

export const OnboardingProviderLogo = ({
  provider,
  className,
}: {
  provider: OnboardingProvider | 'otari'
  className?: string
}) => (
  <span
    aria-hidden="true"
    className={cn('inline-block size-6 shrink-0 bg-current text-muted-foreground', className)}
    style={{
      mask: `url("${provider === 'openrouter' ? openRouterLogo : provider === 'otari' ? otariLogo : tinfoilLogo}") center / contain no-repeat`,
    }}
  />
)
