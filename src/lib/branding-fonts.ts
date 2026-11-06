/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'
import type { BrandingFontFace } from '@shared/branding'
import { fetchBrandingFile } from './branding-files'

/** Where registered faces go: the document's font set, or a stand-in in tests. */
export type FontRegistry<Handle> = {
  add: (face: BrandingFontFace, bytes: ArrayBuffer) => Handle
  remove: (handle: Handle) => void
}

const documentFonts: FontRegistry<FontFace> = {
  add: (face, bytes) => {
    const fontFace = new FontFace(face.family, bytes, {
      style: face.style,
      weight: face.weight,
      unicodeRange: face.unicodeRange,
      display: 'swap',
    })
    document.fonts.add(fontFace)
    return fontFace
  },
  remove: (fontFace) => document.fonts.delete(fontFace),
}

// One file can back several faces: Google serves a variable font's static cuts
// (400 and 700) from the same woff2, so a face is keyed by all its descriptors.
const faceKey = (face: BrandingFontFace) =>
  [face.family, face.style, face.weight, face.unicodeRange, face.file].join('|')

/**
 * A sync function bound to one registry, holding which faces it registered.
 *
 * @param registry - Where faces are registered.
 */
export const createFontSync = <Handle>(registry: FontRegistry<Handle>) => {
  // Keyed by face and stored before the download resolves, so overlapping syncs
  // (the cached config at boot, then the fresh one) never register a face twice.
  // Resolves to undefined when the download failed.
  const registrations = new Map<string, Promise<Handle | undefined>>()

  const register = async (face: BrandingFontFace, client: HttpClient): Promise<Handle | undefined> => {
    try {
      return registry.add(face, await fetchBrandingFile(client, face.file))
    } catch (error) {
      // Fonts are cosmetic: the fallback fonts keep showing.
      console.warn('[branding] font download failed:', face.file, error)
      return undefined
    }
  }

  return async (faces: BrandingFontFace[] | undefined, client: HttpClient) => {
    const wanted = faces ?? []
    const wantedKeys = new Set(wanted.map(faceKey))

    const removals = [...registrations]
      .filter(([key]) => !wantedKeys.has(key))
      .map(async ([key, registration]) => {
        registrations.delete(key)
        const handle = await registration
        if (handle !== undefined) {
          registry.remove(handle)
        }
      })

    const additions = wanted
      .filter((face) => !registrations.has(faceKey(face)))
      .map(async (face) => {
        const key = faceKey(face)
        const registration = register(face, client)
        registrations.set(key, registration)
        // A failed download is forgotten, so the next sync retries it — unless a newer sync already did.
        if ((await registration) === undefined && registrations.get(key) === registration) {
          registrations.delete(key)
        }
      })

    await Promise.all([...removals, ...additions])
  }
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
 * Never rejects: a failed download is logged, and the next sync retries it.
 *
 * @param faces - `branding.fonts`, validated.
 * @param client - A client for the app backend.
 */
export const syncBrandingFonts = createFontSync(documentFonts)
