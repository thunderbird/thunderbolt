/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import type { HttpClient } from '@/lib/http'
import { useResolvedTheme } from '@/lib/theme-provider'
import { isBrandingLogoManifest, type BrandingLogoFile } from '@shared/branding'
import { create } from 'zustand'

/** Downloaded logos as data URLs, keyed by file; `null` marks a failed download. */
const useLogoSourceStore = create<{ sources: Record<string, string | null> }>(() => ({ sources: {} }))

const chunkSize = 0x8000

/** Bytes as base64, in chunks so a large logo can't overflow the argument limit of `fromCharCode`. */
const toBase64 = (bytes: Uint8Array): string =>
  btoa(
    Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) =>
      String.fromCharCode(...bytes.subarray(index * chunkSize, (index + 1) * chunkSize)),
    ).join(''),
  )

/**
 * Point the page's icons at the logo. Web only in effect: the desktop and
 * mobile apps' icons are native and fixed at build time.
 */
const applyFavicon = (href: string) => {
  document.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
  document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon', href }))
  document.querySelector('link[rel="apple-touch-icon"]')?.setAttribute('href', href)
}

const download = async ({ file, type }: BrandingLogoFile, client: HttpClient): Promise<string> => {
  const bytes = new Uint8Array(await (await client.get(`config/logo/${file}`)).arrayBuffer())
  return `data:${type};base64,${toBase64(bytes)}`
}

/**
 * Download the logos `/config` lists and hold them as `data:` URLs.
 *
 * A `data:` URL rather than the backend's URL because the Tauri content
 * security policy allows images only from the app itself, `asset:` and `data:`
 * — it can't name a backend whose address is a user setting (`blob:` isn't
 * allowed either). Files are content-addressed and served `immutable`, so a
 * returning launch reads them from the HTTP cache.
 *
 * @param manifest - `brandingLogo` from `/config`; anything malformed is ignored.
 * @param client - A client for the app backend.
 */
export const syncBrandingLogo = async (manifest: unknown, client: HttpClient) => {
  if (!isBrandingLogoManifest(manifest)) {
    return
  }
  const { sources } = useLogoSourceStore.getState()
  const files = [manifest.light, manifest.dark].filter((file) => file !== undefined)
  await Promise.all(
    files
      .filter((file) => sources[file.file] === undefined)
      .map(async (file) => {
        // A failure is recorded so the logo falls back to the default instead of staying blank.
        const src = await download(file, client).catch(() => null)
        useLogoSourceStore.setState((state) => ({ sources: { ...state.sources, [file.file]: src } }))
        if (file === manifest.light && src) {
          applyFavicon(src)
        }
      }),
  )
}

export type BrandingLogoSource = { kind: 'default' } | { kind: 'loading' } | { kind: 'branded'; src: string }

/**
 * The logo to show for the current theme: the operator's, still loading, or
 * the bundled default (no branded logo, or its download failed). Callers render
 * a same-size blank while loading so the default never flashes in first.
 */
export const useBrandingLogo = (): BrandingLogoSource => {
  const manifest = useConfigStore((state) => state.config.brandingLogo)
  const theme = useResolvedTheme()
  const sources = useLogoSourceStore((state) => state.sources)
  if (!isBrandingLogoManifest(manifest)) {
    return { kind: 'default' }
  }
  const file = theme === 'dark' && manifest.dark ? manifest.dark : manifest.light
  const src = sources[file.file]
  if (src === undefined) {
    return { kind: 'loading' }
  }
  return src ? { kind: 'branded', src } : { kind: 'default' }
}
