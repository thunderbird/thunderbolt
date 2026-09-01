/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useSettings } from '@/hooks/use-settings'
import { applyLanguageSetting } from '@/i18n'
import { sourceLocale } from '@shared/i18n/locales'

/**
 * The `language` setting, with publish-then-persist folded into one call.
 *
 * The ordering is load-bearing and easy to get wrong: `applyLanguageSetting`
 * publishes the locale to the module store *before* the write, because the write
 * queues a PowerSync CRUD upload that reads `X-App-Language` — publish afterwards
 * and the request carrying the change still announces the outgoing language.
 *
 * Every call site used to repeat both steps in order, so a new one could
 * reintroduce that bug just by forgetting the first line, with nothing to catch
 * it. Here the pair cannot be separated.
 */
export const useLanguageSetting = () => {
  const { language } = useSettings({ language: sourceLocale as string })

  return {
    language,
    /** Persist an explicit choice. */
    setLanguage: async (value: string) => {
      void applyLanguageSetting(value)
      await language.setValue(value)
    },
    /** Return the setting to "auto", i.e. whatever the browser negotiates. */
    resetLanguage: async () => {
      void applyLanguageSetting(null)
      await language.reset()
    },
  }
}
