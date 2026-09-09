/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { SiAnthropic } from '@icons-pack/react-simple-icons'
import { Server } from 'lucide-react'

import openAiLogoSrc from '@/assets/openai.svg'
import openRouterLogoSrc from '@/assets/openrouter.svg'
import tinfoilLogoSrc from '@/assets/tinfoil.svg'
import { AppLogo } from '@/components/app-logo'
import { IconTile } from '@/components/settings/icon-tile'
import type { Model } from '@/types'

/** Canonical display names for model providers — the single source for labels.
 *  Key order is the provider-picker menu order (the add form derives its options
 *  from these keys, so a new provider can't silently drop out of the picker). */
// Brand names, deliberately not translated. The one exception is `custom`,
// which is real copy — callers substitute a translated label for it (see
// `customProviderLabel`).
export const providerLabels: Record<Model['provider'], string> = {
  thunderbolt: 'Thunderbolt',
  tinfoil: 'Tinfoil',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  custom: 'Custom',
}

/** System-managed Tinfoil is a Thunderbolt product; Tinfoil is only its transport. */
const isThunderboltManagedModel = (model: Pick<Model, 'provider' | 'isSystem'>): boolean =>
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
      // Unreachable — isThunderboltManagedModel covers it — but keeps the
      // switch exhaustive.
      return null
  }
}

/** Provider logo in the standard settings icon tile (Thunderbolt-branded for managed models). */
export const ModelProviderIconTile = ({ model }: { model: Pick<Model, 'provider' | 'isSystem'> }) => (
  <IconTile>
    <ModelProviderIcon model={model} />
  </IconTile>
)

/** The one provider label that is copy rather than a brand name. */
export const customProviderLabel = msg`Custom`

/** Provider label for display — system-managed Tinfoil models brand as Thunderbolt. */
export const getProviderDisplay = (i18n: I18n, model: Pick<Model, 'provider' | 'isSystem'>): string => {
  if (isThunderboltManagedModel(model)) {
    return 'Thunderbolt'
  }
  return model.provider === 'custom' ? i18n._(customProviderLabel) : providerLabels[model.provider]
}
