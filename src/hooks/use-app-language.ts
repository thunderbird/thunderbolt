/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { activateLocale, getBrowserLanguages } from '@/i18n'
import { sourceLocale } from '@shared/i18n/locales'
import { resolveLocale } from '@/i18n/resolve-locale'
import { usePostHogClient } from '@/lib/posthog'
import { useEffect, useEffectEvent } from 'react'
import { useSettings } from './use-settings'

/**
 * Owns the synced `language` setting's runtime side effects:
 *
 * - **Seeding** — the setting ships as null; while it still holds that default
 *   and is unmodified, infer the
 *   language from `navigator.languages` and store it with `recomputeHash` so
 *   it stays a seeded default rather than a user edit (same mechanic as the
 *   country-derived unit defaults, whose null shipped default lets reconcile's
 *   `wouldOverwriteUserValue` guard preserve the seeded value across
 *   `defaultSettingsVersion` bumps). Seeding only fires from the shipped
 *   default, so devices with different browser languages never ping-pong the
 *   synced row; resetting the setting returns it to null and re-seeds — i.e.
 *   "back to auto".
 * - **Lingui catalog** — activates the resolved locale via `activateLocale`,
 *   loading its catalog chunk and re-rendering translated text. That call is
 *   also what publishes the locale to non-React readers (`X-App-Language`) and
 *   mirrors it to localStorage for the next boot.
 * - **`<html lang>`** — bound to the active locale (index.html ships the
 *   static `lang="en"` as the pre-boot value).
 * - **PostHog `locale`** — registered as a super property and person
 *   property. A coarse BCP-47 tag carries no sensitive payload, and capture
 *   is already consent-gated by `data_collection`.
 *
 * All effects are legitimate per the `useEffect` discipline: a DB write and
 * i18n-store/DOM/analytics synchronization with external systems.
 */
export const useAppLanguage = () => {
  const posthog = usePostHogClient()
  const { language } = useSettings({ language: sourceLocale as string })
  const { rawSetting, isModified, isLoading, isSaving, setValue } = language

  // The raw stored value, not the hook's schema-defaulted one: the setting ships
  // as null, and reading it as `en` would be indistinguishable from an explicit
  // English choice. `resolveLocale` would then return `en` for a German-browser
  // user whose setting is merely unset, publishing `en` until the async seed
  // write below lands — and mirroring it, so a reload in that window starts from
  // `en` rather than negotiating. Passing null keeps "unset" meaning "negotiate",
  // and matches what the settings handler passes to `applyLanguageSetting`.
  const settingValue = rawSetting?.value ?? null

  const activeLocale = resolveLocale(settingValue, getBrowserLanguages())

  const canSeed = !isLoading && !isSaving && !isModified && settingValue === null

  // `useEffectEvent` keeps the unstable `setValue` out of the deps so the
  // effect fires only on the `canSeed` transition, not on every render.
  const seedFromBrowser = useEffectEvent(() => {
    const inferred = resolveLocale(null, getBrowserLanguages())
    if (inferred !== sourceLocale) {
      void setValue(inferred, { recomputeHash: true })
    }
  })

  useEffect(() => {
    if (canSeed) {
      seedFromBrowser()
    }
  }, [canSeed])

  // Nothing is published while the query is in flight. `useSettings` reports the
  // schema fallback until the row arrives, so publishing then would announce
  // `en` on every page load — overwriting the boot-seeded locale in memory and
  // in its localStorage mirror, and sending `X-App-Language: en` on every
  // request that beats hydration.
  useEffect(() => {
    if (isLoading) {
      return
    }
    void activateLocale(activeLocale)
    document.documentElement.lang = activeLocale
  }, [activeLocale, isLoading])

  useEffect(() => {
    if (isLoading) {
      return
    }
    posthog?.register({ locale: activeLocale })
    posthog?.setPersonProperties({ locale: activeLocale })
  }, [activeLocale, isLoading, posthog])
}
