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

// Activate the source locale synchronously with an empty catalog so the first
// render never blocks on a catalog chunk: the macro embeds the English source
// message in the compiled code, and Lingui falls back to it per-message until
// the real catalog arrives.
i18n.loadAndActivate({ locale: sourceLocale, messages: {} })

let activationToken = 0

/**
 * Load a locale's catalog chunk and make it active. Called at boot
 * (src/index.tsx) and whenever the resolved locale changes (`useAppLanguage`).
 *
 * The token makes the last *requested* locale win: without it, concurrent
 * calls (boot overlapping the hook's first activation, or a quick
 * setting flip) would settle on whichever catalog chunk happened to
 * resolve last.
 */
export const activateLocale = async (locale: AppLocale): Promise<void> => {
  const token = ++activationToken
  const { messages } = await catalogLoaders[locale]()
  if (token !== activationToken) {
    return
  }
  i18n.loadAndActivate({ locale, messages })
}

export { i18n }
