/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { I18n } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { SiAnthropic } from '@icons-pack/react-simple-icons'
import { Server, ShieldCheck } from 'lucide-react'

import openAiLogoSrc from '@/assets/openai.svg'
import openRouterLogoSrc from '@/assets/openrouter.svg'
import tinfoilLogoSrc from '@/assets/tinfoil.svg'
import { AppLogo } from '@/components/app-logo'
import { IconTile } from '@/components/settings/icon-tile'
import type { Model } from '@/types'

/** The one provider label that is copy rather than a brand name. */
export const customProviderLabel = msg`Custom`

// Brand names, deliberately not translated, in provider-picker menu order.
// Managed models take the deployment's app name and `custom` is copy, so those
// two are resolved by `getProviderLabel`; any other new provider must be added
// here or `getProviderLabel` fails to compile.
const providerBrandNames: Record<Exclude<Model['provider'], 'thunderbolt' | 'custom'>, string> = {
  tinfoil: 'Tinfoil',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  trustedrouter: 'TrustedRouter',
  anthropic: 'Anthropic',
}

/** Every provider, in provider-picker menu order: managed models first, custom last. */
export const providerPickerOrder: Model['provider'][] = [
  'thunderbolt',
  ...(Object.keys(providerBrandNames) as (keyof typeof providerBrandNames)[]),
  'custom',
]

/**
 * A provider's display name: the deployment's app name for managed models,
 * translated copy for `custom`, else the brand name.
 *
 * @param i18n - For the `custom` label.
 * @param provider - The provider to name.
 * @param appName - The deployment's app name, from `useAppName()`.
 */
export const getProviderLabel = (i18n: I18n, provider: Model['provider'], appName: string): string => {
  if (provider === 'thunderbolt') {
    return appName
  }
  if (provider === 'custom') {
    return i18n._(customProviderLabel)
  }
  return providerBrandNames[provider]
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
    case 'trustedrouter':
      return <ShieldCheck className="size-5 text-muted-foreground" aria-hidden="true" />
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

/**
 * Provider label for a model: managed models, system Tinfoil included, carry the app name.
 *
 * @param i18n - For the `custom` label.
 * @param model - The model to label.
 * @param appName - The deployment's app name, from `useAppName()`.
 */
export const getProviderDisplay = (i18n: I18n, model: Pick<Model, 'provider' | 'isSystem'>, appName: string): string =>
  getProviderLabel(i18n, isThunderboltManagedModel(model) ? 'thunderbolt' : model.provider, appName)
