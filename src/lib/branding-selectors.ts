/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Read-side of operator branding: selectors and hooks only, importing nothing
// but the config store, leaf helpers and the shared contract, so low-level
// modules (agent defaults, model labels, MCP auth) can read the app name
// without pulling in the stylesheet and font machinery in ./branding.

import { useConfigStore, type AppConfig } from '@/api/config-store'
import { privacyPolicyUrl, supportUrl, termsOfServiceUrl } from '@/lib/constants'
import { isRecord } from '@shared/lib/is-record'
import {
  parsePublicBranding,
  resolveAppName,
  resolveDebugTranscriptRecipient,
  type BrandingLinks,
  type PublicBranding,
} from '@shared/branding'

const parsedBrandingCache = new WeakMap<object, PublicBranding>()
// The last malformed value warned about: selectors run on every store update, so warn once per value.
const lastMalformed: { value?: unknown } = {}

/**
 * The operator's branding from `/config`, validated.
 *
 * Re-validated here even though the backend already checks it: these values
 * become a stylesheet, hrefs and request paths, and the backend a client talks
 * to is a local setting. Lenient (see `parsePublicBranding`): a value this
 * client doesn't accept is dropped on its own, so a newer backend never costs
 * an older client its whole theme. Memoized per received object, so it is
 * cheap inside store selectors.
 *
 * @param config - The app config as held by the config store.
 */
export const selectBranding = (config: AppConfig): PublicBranding | undefined => {
  const raw = config.branding
  if (raw === undefined) {
    return undefined
  }
  // A WeakMap key must be an object; anything else is malformed and parses to nothing.
  if (!isRecord(raw)) {
    if (lastMalformed.value !== raw) {
      lastMalformed.value = raw
      console.warn('[branding] ignoring malformed branding from /config')
    }
    return undefined
  }
  const cached = parsedBrandingCache.get(raw)
  if (cached) {
    return cached
  }
  const { branding = {}, issues } = parsePublicBranding(raw)
  if (issues.length > 0) {
    console.warn('[branding] ignoring parts of the branding from /config:', issues)
  }
  parsedBrandingCache.set(raw, branding)
  return branding
}

/** The deployment's app name, or Thunderbolt when the operator sets none. */
export const selectAppName = (config: AppConfig): string => resolveAppName(selectBranding(config))

/** The deployment's app name, reactive to `/config` updates. */
export const useAppName = (): string => useConfigStore((state) => selectAppName(state.config))

/** The app name for code outside React (event handlers, request builders); read at call time. */
export const getAppName = (): string => selectAppName(useConfigStore.getState().config)

/** Who receives shared debug transcripts, named in the share dialog as "the {name} team". */
export const useDebugTranscriptRecipient = (): string =>
  useConfigStore((state) => resolveDebugTranscriptRecipient(selectBranding(state.config)))

/** Privacy policy, terms and support destinations: the operator's, else Thunderbolt's. */
export const useBrandingLinks = (): Required<BrandingLinks> => {
  const links = useConfigStore((state) => selectBranding(state.config)?.links)
  return {
    privacyPolicy: links?.privacyPolicy ?? privacyPolicyUrl,
    termsOfService: links?.termsOfService ?? termsOfServiceUrl,
    support: links?.support ?? supportUrl,
  }
}
