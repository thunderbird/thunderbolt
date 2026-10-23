/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'
import { isBrandingFontFace, type BrandingFontFace } from '@shared/branding'

// Keyed by file and stored before the download resolves, so overlapping syncs
// (the cached config at boot, then the fresh one) never register a face twice.
const registrations = new Map<string, Promise<FontFace>>()

const register = async (face: BrandingFontFace, client: HttpClient): Promise<FontFace> => {
  const bytes = await (await client.get(`config/fonts/${face.file}`)).arrayBuffer()
  const fontFace = new FontFace(face.family, bytes, {
    style: face.style,
    weight: face.weight,
    unicodeRange: face.unicodeRange,
    display: 'swap',
  })
  document.fonts.add(fontFace)
  return fontFace
}

/**
 * Register the backend's branding font faces with the document, and drop the
 * ones `/config` no longer lists.
 *
 * Each file is fetched as bytes and handed to `FontFace` rather than loaded
 * from a URL: the Tauri content security policy allows fonts only from the app
 * itself (`font-src 'self' data:`), and the backend's address is a user setting
 * the policy can't name. A policy governs font *loads*, not bytes the page
 * already holds — confirmed in Chromium and WebKit. The files are
 * content-addressed and served `immutable`, so returning launches, offline
 * ones included, come from the HTTP cache.
 *
 * @param faces - `brandingFonts` from `/config`; malformed entries are skipped.
 * @param client - A client for the app backend.
 */
export const syncBrandingFonts = async (faces: unknown[] | undefined, client: HttpClient) => {
  const wanted = (faces ?? []).filter(isBrandingFontFace)
  const wantedFiles = new Set(wanted.map((face) => face.file))

  for (const [file, registration] of registrations) {
    if (!wantedFiles.has(file)) {
      registrations.delete(file)
      void registration.then(
        (fontFace) => document.fonts.delete(fontFace),
        () => undefined,
      )
    }
  }

  const pending = wanted
    .filter((face) => !registrations.has(face.file))
    .map((face) => {
      const registration = register(face, client)
      registrations.set(face.file, registration)
      // A failed download is forgotten, so the next sync retries it.
      registration.catch(() => registrations.delete(face.file))
      return registration
    })
  await Promise.all(pending)
}
