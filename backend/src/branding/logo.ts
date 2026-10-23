/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  brandingLogoTypes,
  type Branding,
  type BrandingLogoFile,
  type BrandingLogoManifest,
  type BrandingLogoType,
} from '@shared/branding'

const requestTimeoutMs = 10_000
const maxLogoBytes = 512 * 1024

export type BrandingLogoLogger = {
  info: (context: Record<string, unknown>, message: string) => void
  warn: (context: Record<string, unknown>, message: string) => void
}

export type BrandingLogoService = {
  /** The downloaded logos; undefined until `load` finishes, or when nothing downloaded. */
  manifest: () => BrandingLogoManifest | undefined
  /** A served logo file by its content-addressed name. */
  file: (name: string) => { bytes: Uint8Array<ArrayBuffer>; type: BrandingLogoType } | undefined
  /** Downloads the configured logos; resolves once every attempt finishes, never rejects. */
  load: () => Promise<void>
}

/** Serves nothing: what an app gets when nothing downloaded a logo for it. */
export const noBrandingLogo: Pick<BrandingLogoService, 'manifest' | 'file'> = {
  manifest: () => undefined,
  file: () => undefined,
}

const isLogoType = (type: string): type is BrandingLogoType => type in brandingLogoTypes

const contentName = async (bytes: Uint8Array<ArrayBuffer>, type: BrandingLogoType): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex}.${brandingLogoTypes[type]}`
}

/**
 * Downloads the operator's logo (light, and dark if set) once, at startup, and
 * holds it in memory for `GET /config/logo/:file`. The client fetches it from
 * there as bytes and renders a `data:` URL — the one image source the Tauri
 * content security policy allows from a backend whose address is a user setting.
 *
 * Only image types render, capped in size; an SVG can't run script, because the
 * client only ever shows it through `<img>` and the favicon link. A failure is
 * logged rather than fatal, and the app keeps its default logo.
 */
export const createBrandingLogo = (
  branding: Branding | undefined,
  options: { fetchFn?: typeof fetch; logger: BrandingLogoLogger },
): BrandingLogoService => {
  const fetchFn = options.fetchFn ?? globalThis.fetch
  const files = new Map<string, { bytes: Uint8Array<ArrayBuffer>; type: BrandingLogoType }>()
  const state: { manifest?: BrandingLogoManifest } = {}

  const download = async (url: string): Promise<BrandingLogoFile> => {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(requestTimeoutMs) })
    if (!response.ok) {
      throw new Error(`Logo request failed with ${response.status}`)
    }
    const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (!isLogoType(type)) {
      throw new Error(`Logo must be SVG, PNG, WebP or JPEG; got "${type || 'no content type'}"`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > maxLogoBytes) {
      throw new Error(`Logo is ${bytes.byteLength} bytes; the limit is ${maxLogoBytes}`)
    }
    const file = await contentName(bytes, type)
    files.set(file, { bytes, type })
    return { file, type }
  }

  return {
    manifest: () => state.manifest,
    file: (name) => files.get(name),
    load: async () => {
      const logo = branding?.logo
      if (!logo) {
        return
      }
      try {
        const [light, dark] = await Promise.all([download(logo.light), logo.dark ? download(logo.dark) : undefined])
        state.manifest = { light, ...(dark && { dark }) }
        options.logger.info({ light: logo.light, dark: logo.dark }, 'Branding logo loaded')
      } catch (error) {
        options.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Branding logo could not be loaded; the app keeps its default logo',
        )
      }
    },
  }
}
