/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SiAnthropic } from '@icons-pack/react-simple-icons'
import { Server } from 'lucide-react'

import openAiLogoSrc from '@/assets/openai.svg'
import openRouterLogoSrc from '@/assets/openrouter.svg'
import tinfoilLogoSrc from '@/assets/tinfoil.svg'
import { AppLogo } from '@/components/app-logo'
import type { Model } from '@/types'

/** System-managed Tinfoil is a Thunderbolt product; Tinfoil is only its transport. */
export const isThunderboltManagedModel = (model: Pick<Model, 'provider' | 'isSystem'>): boolean =>
  model.provider === 'thunderbolt' || (model.provider === 'tinfoil' && model.isSystem === 1)

const ModelProviderIcon = ({ model }: { model: Pick<Model, 'provider' | 'isSystem'> }) => {
  if (isThunderboltManagedModel(model)) {
    return <AppLogo size={20} alt="" />
  }
  switch (model.provider) {
    case 'openai':
      return <img src={openAiLogoSrc} alt="" className="size-5 dark:invert" />
    case 'anthropic':
      return <SiAnthropic size={20} aria-hidden="true" />
    case 'openrouter':
      return <img src={openRouterLogoSrc} alt="" className="h-5 w-auto dark:invert" />
    case 'tinfoil':
      return <img src={tinfoilLogoSrc} alt="" className="size-5 dark:invert" />
    case 'custom':
      return <Server className="size-5 text-muted-foreground" aria-hidden="true" />
    case 'thunderbolt':
      return null
  }
}

export const ModelProviderIconTile = ({ model }: { model: Pick<Model, 'provider' | 'isSystem'> }) => (
  <div className="flex aspect-square size-9 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">
    <ModelProviderIcon model={model} />
  </div>
)

export const getProviderDisplay = (model: Pick<Model, 'provider' | 'isSystem'>): string => {
  if (isThunderboltManagedModel(model)) {
    return 'Thunderbolt'
  }
  const labels: Record<Model['provider'], string> = {
    thunderbolt: 'Thunderbolt',
    tinfoil: 'Tinfoil',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    custom: 'Custom',
    openrouter: 'OpenRouter',
  }
  return labels[model.provider]
}
