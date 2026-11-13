/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import exaLogo from '@/assets/exa.svg'
import tavilyLogo from '@/assets/tavily.svg'
import { SiAnthropic, SiBrave } from '@icons-pack/react-simple-icons'
import { Search, Server, Shield } from 'lucide-react'
import openAiLogo from '@/assets/openai.svg'
import { ProviderBrandLogo } from '@/components/provider-brand-logo'
import { getProviderDefinition } from '@/providers/registry'
import type { ProviderType } from '@/providers/types'

/** Uses provider identity for connection rows, independent of any selected model. */
export const ProviderConnectionIcon = ({ provider }: { provider: ProviderType }) => {
  if (provider === 'privatemode') {
    return <Shield className="size-5" aria-hidden="true" />
  }
  if (provider === 'openrouter' || provider === 'tinfoil' || provider === 'otari') {
    return <ProviderBrandLogo provider={provider} className="size-5" />
  }
  if (provider === 'brave') {
    return <SiBrave className="size-5" color="default" aria-hidden="true" />
  }
  if (provider === 'exa' || provider === 'tavily') {
    return (
      <img
        src={provider === 'exa' ? exaLogo : tavilyLogo}
        className={provider === 'tavily' ? 'size-5 dark:invert' : 'size-5'}
        alt=""
      />
    )
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
