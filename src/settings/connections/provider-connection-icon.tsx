/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SiAnthropic } from '@icons-pack/react-simple-icons'
import { Search, Server } from 'lucide-react'
import openAiLogo from '@/assets/openai.svg'
import { ProviderBrandLogo } from '@/components/provider-brand-logo'
import { getProviderDefinition } from '@/providers/registry'
import type { ProviderType } from '@/providers/types'

/** Uses provider identity for connection rows, independent of any selected model. */
export const ProviderConnectionIcon = ({ provider }: { provider: ProviderType }) => {
  if (provider === 'openrouter' || provider === 'tinfoil' || provider === 'otari') {
    return <ProviderBrandLogo provider={provider} className="size-5" />
  }
  if (provider === 'anthropic') {
    return <SiAnthropic className="size-5" aria-hidden="true" />
  }
  if (provider === 'openai') {
    return <img src={openAiLogo} className="size-5 dark:invert" alt="" />
  }
  return getProviderDefinition(provider).capabilities.includes('search') ? (
    <Search className="size-5" aria-hidden="true" />
  ) : (
    <Server className="size-5" aria-hidden="true" />
  )
}
