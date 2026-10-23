/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { configRoutesPrefix, emailLogoRoute } from '@/api/config-paths'
import type { BrandingAssets } from '@/branding/assets'
import type { BrandingFile } from '@/branding/download'
import { bundledEmailLogoUrl } from '@/branding/email-logo'
import { isPasskeyEnabled, type Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { toPublicBranding } from '@shared/branding'
import { defaultModelId, defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { Elysia } from 'elysia'

// Sandboxed and never sniffed: an SVG logo opened directly from the API origin
// must not run script — on single-origin deployments that origin is the app's.
const brandingFileHeaders = {
  'Content-Security-Policy': 'sandbox',
  'X-Content-Type-Options': 'nosniff',
  'Content-Disposition': 'attachment',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

const serveBrandingFile = (file: BrandingFile, cacheControl: string) =>
  new Response(file.bytes, {
    headers: { ...brandingFileHeaders, 'Content-Type': file.type, 'Cache-Control': cacheControl },
  })

// Email clients render PNG and JPEG; few render SVG or WebP.
const emailLogoTypes = new Set(['image/png', 'image/jpeg'])

// Content-addressed names never change meaning, so clients may cache them forever.
const immutableCache = 'public, max-age=31536000, immutable'
// The email logo's URL is fixed while what it serves isn't: a redirect sent
// before the download landed must expire, so mail proxies re-check hourly.
const emailLogoCache = 'public, max-age=3600'

/**
 * Public app config — the single source of deployment-level UI capability flags
 * (no auth, fetched at boot). The frontend mirrors this into its config store and
 * falls back to the cached value when offline (standalone mode keeps working).
 *
 * `defaults` ships the reconciled default sets (models today, more to follow) as
 * an OTA channel: clients pick between the server payload and their bundled copy
 * by comparing versions, so shipped defaults changes don't require a client
 * release. See "Reconciled defaults and version bumps" in AGENTS.md.
 *
 * `branding` is the operator's `BRANDING` with the logo URLs swapped for the
 * files the backend downloaded and the font faces it resolved; the files are
 * served at `/config/branding/:file`, under `/config` because they are public
 * config too, and so share its app-version exemption.
 *
 * @param settings - The backend settings.
 * @param brandingAssets - The branding files downloaded so far.
 */
export const createConfigRoutes = (settings: Settings, brandingAssets: BrandingAssets) =>
  new Elysia({ prefix: configRoutesPrefix })
    .onError(safeErrorHandler)
    .get('/', () => ({
      // Compatibility shim, not a live flag. E2EE is unconditionally on, but
      // pre-cutover bundles gate `encodeForUpload` on `config.e2eeEnabled`, and
      // `updateConfig` replaces the whole config object — so omitting this key
      // makes a stale client read it as `undefined`, skip encryption, and upload
      // PLAINTEXT into an account current clients treat as encrypted. There is no
      // bulk re-encryption pass, so that data stays plaintext forever.
      // Safe to delete once MIN_APP_VERSION is at or above the first release that
      // shipped always-on E2EE, which 426s every client that still reads this.
      e2eeEnabled: true,
      orgEscrowEnabled: settings.orgEscrowEnabled,
      debugTranscriptsEnabled: settings.debugTranscriptsEnabled,
      passkeyEnabled: isPasskeyEnabled(settings),
      // The client's sync-unlock assertion must name the same RP ID as sign-in, or
      // an apex PASSKEY_RP_ID wouldn't find the passkey from a subdomain.
      passkeyRpId: isPasskeyEnabled(settings) ? settings.passkeyRpId : undefined,
      // Inverted so the env reads as an opt-in switch ("disable") while the wire
      // contract reads as a positive capability ("enabled").
      builtInAgentEnabled: !settings.disableBuiltInAgent,
      allowCustomAgents: settings.allowCustomAgents,
      minimalMode: settings.minimalMode,
      brandLogoUrl: settings.brandLogoUrl,
      brandLogoDarkUrl: settings.brandLogoDarkUrl,
      brandLogoAlt: settings.brandLogoAlt,
      // Omitted when unset, so the client keeps its bundled theme. `fonts` and `logo`
      // are omitted until their downloads land.
      branding:
        settings.branding &&
        toPublicBranding(settings.branding, { fonts: brandingAssets.fonts(), logo: brandingAssets.logo() }),
      // Omit when unset so the frontend treats it as "no enforcement" without parsing an empty string as semver.
      minAppVersion: settings.minAppVersion || undefined,
      defaults: {
        models: {
          version: defaultModelsVersion,
          defaultModelId,
          data: defaultModels,
        },
      },
    }))
    // The light logo for emails: the operator's when email clients can show it,
    // else a redirect to the bundled mark.
    .get(emailLogoRoute, () => {
      const light = brandingAssets.logo()?.light
      const file = light && emailLogoTypes.has(light.type) ? brandingAssets.file(light.file) : undefined
      if (!file) {
        return new Response(null, {
          status: 302,
          headers: { Location: bundledEmailLogoUrl(settings.appUrl), 'Cache-Control': emailLogoCache },
        })
      }
      return serveBrandingFile(file, emailLogoCache)
    })
    .get('/branding/:file', ({ params, status }) => {
      const file = brandingAssets.file(params.file)
      if (!file) {
        return status(404, 'Not found')
      }
      return serveBrandingFile(file, immutableCache)
    })
