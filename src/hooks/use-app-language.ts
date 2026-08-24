/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { activateLocale } from '@/i18n'
import { sourceLocale } from '@/i18n/locales'
import { getBrowserLanguages, resolveLocale } from '@/i18n/resolve-locale'
import { usePostHogClient } from '@/lib/posthog'
import { useEffect, useEffectEvent } from 'react'
import { useSettings } from './use-settings'

/**
 * Owns the synced `language` setting's runtime side effects:
 *
 * - **Seeding** — the setting ships as null (read as `'en'` via the schema
 *   fallback); while it still holds that default and is unmodified, infer the
 *   language from `navigator.languages` and store it with `recomputeHash` so
 *   it stays a seeded default rather than a user edit (same mechanic as the
 *   country-derived unit defaults, whose null shipped default lets reconcile's
 *   `wouldOverwriteUserValue` guard preserve the seeded value across
 *   `defaultSettingsVersion` bumps). Seeding only fires from the shipped
 *   default, so devices with different browser languages never ping-pong the
 *   synced row; resetting the setting returns it to null and re-seeds — i.e.
 *   "back to auto".
 * - **Lingui catalog** — activates the resolved locale via `activateLocale`,
 *   loading its catalog chunk and re-rendering translated text.
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
  const { value, isModified, isLoading, isSaving, setValue } = language

  const activeLocale = resolveLocale(value, getBrowserLanguages())

  const canSeed = !isLoading && !isSaving && !isModified && value === sourceLocale

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

  useEffect(() => {
    void activateLocale(activeLocale)
    document.documentElement.lang = activeLocale
  }, [activeLocale])

  useEffect(() => {
    posthog?.register({ locale: activeLocale })
    posthog?.setPersonProperties({ locale: activeLocale })
  }, [activeLocale, posthog])
}
