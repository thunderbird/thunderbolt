/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useConfigStore } from '@/api/config-store'
import { uint8ArrayToBase64 } from '@/crypto/primitives'
import type { HttpClient } from '@/lib/http'
import { useResolvedTheme } from '@/lib/theme-provider'
import type { BrandingLogoFile, BrandingLogoManifest } from '@shared/branding'
import { create } from 'zustand'
import { fetchBrandingFile } from './branding-files'
import { selectBranding } from './branding-selectors'

/** Downloaded logos as data URLs, keyed by file; `null` marks a failed download, retried on the next sync. */
const useLogoSourceStore = create<{ sources: Record<string, string | null> }>(() => ({ sources: {} }))

// Downloads in flight, so overlapping syncs (cached config, then fresh) fetch each file once.
const inFlight = new Map<string, Promise<void>>()

const download = async ({ file, type }: BrandingLogoFile, client: HttpClient): Promise<void> => {
  try {
    const bytes = new Uint8Array(await fetchBrandingFile(client, file))
    const src = `data:${type};base64,${uint8ArrayToBase64(bytes)}`
    useLogoSourceStore.setState((state) => ({ sources: { ...state.sources, [file]: src } }))
  } catch (error) {
    // Recorded so the logo falls back to the default instead of staying blank.
    console.warn('[branding] logo download failed:', file, error)
    useLogoSourceStore.setState((state) => ({ sources: { ...state.sources, [file]: null } }))
  }
}

const downloadOnce = async (logo: BrandingLogoFile, client: HttpClient): Promise<void> => {
  const existing = inFlight.get(logo.file)
  if (existing) {
    return existing
  }
  const started = download(logo, client)
  inFlight.set(logo.file, started)
  await started
  // Only this download's own entry; a reset may have let a newer one start since.
  if (inFlight.get(logo.file) === started) {
    inFlight.delete(logo.file)
  }
}

/**
 * Download the logos `branding.logo` lists and hold them as `data:` URLs;
 * `useBrandingLogo` and the favicon read them from there.
 *
 * A `data:` URL rather than the backend's URL because the Tauri content
 * security policy limits images to the app itself, `asset:`, `data:` and the
 * hosted API — it can't name a backend whose address is a user setting
 * (`blob:` isn't allowed either). Files are content-addressed and served
 * `immutable`, so a returning launch reads them from the HTTP cache. A failed
 * download is logged and retried on the next sync.
 *
 * @param manifest - `branding.logo`, validated.
 * @param client - A client for the app backend.
 */
export const syncBrandingLogos = async (manifest: BrandingLogoManifest | undefined, client: HttpClient) => {
  if (!manifest) {
    return
  }
  const { sources } = useLogoSourceStore.getState()
  const files = [manifest.light, manifest.dark].filter((logo) => logo !== undefined)
  await Promise.all(files.filter((logo) => !sources[logo.file]).map((logo) => downloadOnce(logo, client)))
}

/** The page's own icons, captured before the first logo replaces them; and the href last applied. */
const favicons: { bundled?: { icons: Element[]; touchIcon: string | null }; applied?: string } = {}

/**
 * Point the page's icons at the logo, or back at the bundled ones. Web only in
 * effect: the desktop and mobile apps' icons are native and fixed at build time.
 */
const applyFavicon = (href: string | undefined) => {
  if (href === favicons.applied) {
    return
  }
  const touchIcon = document.querySelector('link[rel="apple-touch-icon"]')
  const bundled = (favicons.bundled ??= {
    icons: [...document.querySelectorAll('link[rel="icon"]')],
    touchIcon: touchIcon?.getAttribute('href') ?? null,
  })
  const icons = href ? [Object.assign(document.createElement('link'), { rel: 'icon', href })] : bundled.icons
  document.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
  document.head.append(...icons)
  const touchHref = href ?? bundled.touchIcon
  if (touchHref) {
    touchIcon?.setAttribute('href', touchHref)
  }
  favicons.applied = href
}

const lightLogoSource = (): string | undefined => {
  const manifest = selectBranding(useConfigStore.getState().config)?.logo
  return manifest ? (useLogoSourceStore.getState().sources[manifest.light.file] ?? undefined) : undefined
}

/**
 * Keep the favicon on the current config's light logo once it has downloaded,
 * and on the bundled icons otherwise. Derived from the two stores, so a late
 * download for a config that has since changed can't set a stale icon.
 *
 * @returns Unsubscribes.
 */
export const installFavicon = (): (() => void) => {
  const apply = () => applyFavicon(lightLogoSource())
  apply()
  const unsubscribeConfig = useConfigStore.subscribe(apply)
  const unsubscribeLogos = useLogoSourceStore.subscribe(apply)
  return () => {
    unsubscribeConfig()
    unsubscribeLogos()
  }
}

/** Forgets every downloaded logo and the captured favicons; for tests, which share this module's state. */
export const clearBrandingLogos = () => {
  useLogoSourceStore.setState({ sources: {} })
  inFlight.clear()
  favicons.bundled = undefined
  favicons.applied = undefined
}

type BrandingLogoSource = { kind: 'default' } | { kind: 'loading' } | { kind: 'branded'; src: string }

/**
 * The logo to show for the current theme: the operator's, still loading, or
 * the bundled default (no branded logo, or its download failed). Callers render
 * a same-size blank while loading so the default never flashes in first.
 */
export const useBrandingLogo = (): BrandingLogoSource => {
  const manifest = useConfigStore((state) => selectBranding(state.config)?.logo)
  const theme = useResolvedTheme()
  const sources = useLogoSourceStore((state) => state.sources)
  if (!manifest) {
    return { kind: 'default' }
  }
  // A dark logo that failed (null) falls back to the light one, as it would if unset.
  const darkSource = theme === 'dark' && manifest.dark ? sources[manifest.dark.file] : null
  const src = darkSource === null ? sources[manifest.light.file] : darkSource
  if (src === undefined) {
    return { kind: 'loading' }
  }
  return src ? { kind: 'branded', src } : { kind: 'default' }
}
