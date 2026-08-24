/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Messages } from '@lingui/core'
import { i18n } from '@lingui/core'
import { appLocales, sourceLocale, type AppLocale } from './locales'

export { appLocales, sourceLocale, type AppLocale }

// Each catalog loads through import() so every locale ships as its own async
// chunk — statically bundling catalogs would grow the size-limit-gated entry
// chunk with bytes only one locale ever uses.
const catalogLoaders: Record<AppLocale, () => Promise<{ messages: Messages }>> = {
  en: () => import('@/locales/en/messages.po'),
  de: () => import('@/locales/de/messages.po'),
  fr: () => import('@/locales/fr/messages.po'),
  es: () => import('@/locales/es/messages.po'),
  'pt-BR': () => import('@/locales/pt-BR/messages.po'),
  ja: () => import('@/locales/ja/messages.po'),
  'en-XA': () => import('@/locales/en-XA/messages.po'),
}

const isAppLocale = (value: string | undefined): value is AppLocale =>
  !!value && (appLocales as readonly string[]).includes(value)

/**
 * Resolve the active UI locale. Fixed to the source locale until THU-805
 * lands the synced `language` setting and negotiation chain. VITE_APP_LOCALE
 * lets CI and local runs force a locale — the en-XA pseudo-locale build and
 * manual pseudo-localization checks use this.
 */
export const getAppLocale = (): AppLocale => {
  const override = import.meta.env.VITE_APP_LOCALE
  return isAppLocale(override) ? override : sourceLocale
}

// Activate the source locale synchronously with an empty catalog so the first
// render never blocks on a catalog chunk: the macro embeds the English source
// message in the compiled code, and Lingui falls back to it per-message until
// the real catalog arrives.
i18n.loadAndActivate({ locale: sourceLocale, messages: {} })

/**
 * Load a locale's catalog chunk and make it active. Also the locale-switch
 * entry point once THU-805 lands.
 */
export const activateLocale = async (locale: AppLocale): Promise<void> => {
  const { messages } = await catalogLoaders[locale]()
  i18n.loadAndActivate({ locale, messages })
}

export { i18n }
