/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Read-side of operator branding: selectors and hooks only, importing nothing
// but the config store and the shared contract, so low-level modules (agent
// defaults, model labels, MCP auth) can read the app name without pulling in
// the stylesheet and font machinery in ./branding.

import { useConfigStore, type AppConfig } from '@/api/config-store'
import { privacyPolicyUrl, supportUrl, termsOfServiceUrl } from '@/lib/constants'
import { defaultAppName, parseBranding, type Branding, type BrandingLinks } from '@shared/branding'

const parsed = new WeakMap<object, Branding | undefined>()

/**
 * The operator's branding from `/config`, validated.
 *
 * Re-validated here even though the backend already checks it: these values
 * become a stylesheet, and the backend a client talks to is a local setting.
 * Anything invalid drops the whole branding rather than half-applying it.
 * Memoized per config object, so it is cheap inside store selectors.
 *
 * @param config - The app config as held by the config store.
 */
export const selectBranding = (config: AppConfig): Branding | undefined => {
  const raw = config.branding
  if (!raw) {
    return undefined
  }
  if (!parsed.has(raw)) {
    const result = parseBranding(raw)
    if (!result.ok) {
      console.warn('[branding] ignoring invalid branding from /config:', result.errors)
    }
    parsed.set(raw, result.ok ? result.branding : undefined)
  }
  return parsed.get(raw)
}

/** The deployment's app name, or Thunderbolt when the operator sets none. */
export const selectAppName = (config: AppConfig): string => selectBranding(config)?.appName ?? defaultAppName

/** The deployment's app name, reactive to `/config` updates. */
export const useAppName = (): string => useConfigStore((state) => selectAppName(state.config))

/** Privacy policy, terms and support destinations: the operator's, else Thunderbolt's. */
export const useBrandingLinks = (): Required<BrandingLinks> => {
  const links = useConfigStore((state) => selectBranding(state.config)?.links)
  return {
    privacyPolicy: links?.privacyPolicy ?? privacyPolicyUrl,
    termsOfService: links?.termsOfService ?? termsOfServiceUrl,
    support: links?.support ?? supportUrl,
  }
}
