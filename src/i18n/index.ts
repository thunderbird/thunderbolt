/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Messages } from '@lingui/core'
import { i18n } from '@lingui/core'
import { messages as sourceMessages } from '@/locales/en/messages.po'
import { appLocales, sourceLocale, type AppLocale } from '@shared/i18n/locales'

export { appLocales, sourceLocale, type AppLocale }

// Each translated catalog loads through import() so it ships as its own async
// chunk — statically bundling all seven would grow the entry chunk with bytes
// only one locale ever uses. `en` is the exception: see the activation below.
const catalogLoaders: Record<AppLocale, () => Promise<{ messages: Messages }>> = {
  en: () => import('@/locales/en/messages.po'),
  de: () => import('@/locales/de/messages.po'),
  fr: () => import('@/locales/fr/messages.po'),
  es: () => import('@/locales/es/messages.po'),
  'pt-BR': () => import('@/locales/pt-BR/messages.po'),
  ja: () => import('@/locales/ja/messages.po'),
  'en-XA': () => import('@/locales/en-XA/messages.po'),
}

// Activate the source locale synchronously so the first render never blocks on
// a catalog chunk, and every message has real text until the user's own catalog
// arrives.
//
// The `en` catalog is imported statically rather than loaded through the map
// above, and an empty `{}` will not do: production builds compile macros with
// `descriptorFields: 'id-only'`, so a call site carries only its hash id and no
// `message` to fall back on. Against an empty catalog Lingui renders that id —
// users would read `u5SXpP` until the chunk resolves. The compiled catalog also
// spares us a runtime message compiler, which `@lingui/core` installs only
// outside production, so placeholders and plurals interpolate on first paint
// instead of printing raw ICU.
i18n.loadAndActivate({ locale: sourceLocale, messages: sourceMessages })

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
