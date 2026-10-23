/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { BrandingFonts } from '@/branding/fonts'
import type { BrandingLogoService } from '@/branding/logo'
import { isPasskeyEnabled, type Settings } from '@/config/settings'
import { safeErrorHandler } from '@/middleware/error-handling'
import { defaultModelId, defaultModels, defaultModelsVersion } from '@shared/defaults/models'
import { Elysia } from 'elysia'

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
 * `/config/fonts/:file` and `/config/logo/:file` serve the branding files the
 * backend downloaded at startup; they sit under `/config` because they are
 * public config too, and so share its app-version exemption.
 */
/** The branding files `startServer` downloaded; tests and plain `createApp` pass the empty ones. */
export type BrandingAssets = {
  fonts: Pick<BrandingFonts, 'faces' | 'file'>
  logo: Pick<BrandingLogoService, 'manifest' | 'file'>
}

export const createConfigRoutes = (settings: Settings, { fonts: brandingFonts, logo: brandingLogo }: BrandingAssets) =>
  new Elysia({ prefix: '/config' })
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
      debugTranscriptRecipientName: settings.debugTranscriptRecipientName,
      passkeyEnabled: isPasskeyEnabled(settings),
      // The client's sync-unlock assertion must name the same RP ID as sign-in, or
      // an apex PASSKEY_RP_ID wouldn't find the passkey from a subdomain.
      passkeyRpId: isPasskeyEnabled(settings) ? settings.passkeyRpId : undefined,
      // Inverted so the env reads as an opt-in switch ("disable") while the wire
      // contract reads as a positive capability ("enabled").
      builtInAgentEnabled: !settings.disableBuiltInAgent,
      allowCustomAgents: settings.allowCustomAgents,
      minimalMode: settings.minimalMode,
      // Omitted when unset, so the client keeps its bundled theme.
      branding: settings.branding,
      // Font faces resolved so far; omitted until the startup download produces any.
      brandingFonts: brandingFonts.faces().length > 0 ? brandingFonts.faces() : undefined,
      // The downloaded logo files; omitted until the startup download succeeds.
      brandingLogo: brandingLogo.manifest(),
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
    .get('/fonts/:file', ({ params, status }) => {
      const bytes = brandingFonts.file(params.file)
      if (!bytes) {
        return status(404, 'Not found')
      }
      // Content-addressed names never change meaning, so clients may cache forever.
      return new Response(bytes, {
        headers: { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' },
      })
    })
    .get('/logo/:file', ({ params, status }) => {
      const logo = brandingLogo.file(params.file)
      if (!logo) {
        return status(404, 'Not found')
      }
      return new Response(logo.bytes, {
        headers: { 'Content-Type': logo.type, 'Cache-Control': 'public, max-age=31536000, immutable' },
      })
    })
