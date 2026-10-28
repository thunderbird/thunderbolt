/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Branding, BrandingFontFace, BrandingLogoFile, BrandingLogoManifest } from '@shared/branding'
import { isRetryable, type BrandingFetch, type BrandingFile, type BrandingLogger } from './download'
import { downloadFontFamily, familiesToLoad } from './fonts'
import { downloadLogo } from './logo'

/** What `GET /config` reads: the files downloaded so far and what they make up. */
export type BrandingAssets = {
  /** Font faces resolved so far; undefined while none are. */
  fonts: () => BrandingFontFace[] | undefined
  /** The downloaded logos; undefined until the light one is in. A missing dark one falls back to light. */
  logo: () => BrandingLogoManifest | undefined
  /** A downloaded file by its content-addressed name. */
  file: (name: string) => BrandingFile | undefined
}

/** Serves nothing: what an app gets when nothing downloads branding for it (tests, plain `createApp`). */
export const noBrandingAssets: BrandingAssets = {
  fonts: () => undefined,
  logo: () => undefined,
  file: () => undefined,
}

type Download = {
  context: Record<string, unknown>
  run: () => Promise<void>
}

// 30s, 1m, 2m, … capped at 15 minutes: a host that is down at boot gets picked
// up soon after it recovers, and one that never answers costs a log line a quarter-hour.
const retryDelayMs = (attemptNumber: number) => Math.min(30_000 * 2 ** attemptNumber, 15 * 60_000)

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const scheduleRetry = (retry: () => Promise<void>, delayMs: number) => {
  setTimeout(() => void retry(), delayMs).unref()
}

/**
 * Downloads the operator's fonts (from Google Fonts) and logos (from their
 * URLs) and holds the files in memory for `GET /config/branding/:file`.
 * Users' browsers only ever talk to this backend, so neither Google nor the
 * logo host sees a user.
 *
 * Each font family and each logo is its own download: one that fails is
 * logged and retried with backoff without holding back the others, so a pod
 * that boots while a host is down brands itself once the host is back. A
 * failure no retry can fix (`isRetryable`) — a final 4xx, a wrong type, a
 * redirect loop, a URL the SSRF guard refuses — is logged once as an error and
 * not retried. Anything Google Fonts serves is the exception: it always retries.
 *
 * Every process downloads on its own, so behind a load balancer two of them
 * can briefly disagree (one still retrying); a client that misses a file
 * falls back to the default and picks it up on its next launch.
 *
 * @param branding - The validated `BRANDING`.
 * @param options.fetchFn - The fetch to download with; `startServer` passes the SSRF-safe, https-only one.
 * @param options.logger - Where downloads and failures are logged.
 * @param options.schedule - How a failed download is retried later; tests run retries by hand.
 */
export const createBrandingAssets = (
  branding: Branding | undefined,
  options: {
    fetchFn: BrandingFetch
    logger: BrandingLogger
    schedule?: (retry: () => Promise<void>, delayMs: number) => void
  },
): BrandingAssets & {
  /**
   * Runs each download once, scheduling retries for failures; resolves when
   * every first attempt has finished, never rejects. Later calls share the first run.
   */
  load: () => Promise<void>
  /** `load`, waiting at most `waitMs`; true when every first attempt finished in time. */
  loadWithin: (waitMs: number) => Promise<boolean>
} => {
  const { fetchFn, logger, schedule = scheduleRetry } = options
  const files = new Map<string, BrandingFile>()
  const fonts: BrandingFontFace[] = []
  const logos: { light?: BrandingLogoFile; dark?: BrandingLogoFile } = {}

  const fontDownloads = familiesToLoad(branding).map(
    (family): Download => ({
      context: { family },
      run: async () => {
        const downloaded = await downloadFontFamily(family, fetchFn)
        if (!downloaded) {
          logger.info({ family }, 'Branding font not on Google Fonts; assuming it is installed on devices')
          return
        }
        downloaded.files.forEach((file) => files.set(file.name, file))
        fonts.push(...downloaded.faces)
        logger.info({ family, faces: downloaded.faces.length }, 'Branding font loaded from Google Fonts')
      },
    }),
  )

  const logoDownloads = (['light', 'dark'] as const).flatMap((mode): Download[] => {
    const url = branding?.logo?.[mode]
    if (!url) {
      return []
    }
    return [
      {
        context: { logo: mode, host: new URL(url).host },
        run: async () => {
          const { logo, file } = await downloadLogo(url, fetchFn)
          files.set(file.name, file)
          logos[mode] = logo
          logger.info({ logo: mode, type: logo.type }, 'Branding logo loaded')
        },
      },
    ]
  })

  const attempt = async (download: Download, attemptNumber: number): Promise<void> => {
    try {
      await download.run()
    } catch (error) {
      const context = { ...download.context, error: errorMessage(error), attempt: attemptNumber + 1 }
      if (!isRetryable(error)) {
        logger.error(context, 'Branding download failed and will not be retried; fix BRANDING and restart')
        return
      }
      const delayMs = retryDelayMs(attemptNumber)
      logger.warn(
        { ...context, retryInMs: delayMs },
        'Branding download failed; the app shows its defaults until a retry succeeds',
      )
      schedule(() => attempt(download, attemptNumber + 1), delayMs)
    }
  }

  const attemptAll = async () => {
    await Promise.all([...fontDownloads, ...logoDownloads].map((download) => attempt(download, 0)))
  }
  const firstLoad: { promise?: Promise<void> } = {}
  const load = () => {
    firstLoad.promise ??= attemptAll()
    return firstLoad.promise
  }

  return {
    fonts: () => (fonts.length > 0 ? fonts : undefined),
    logo: () => (logos.light ? { light: logos.light, ...(logos.dark && { dark: logos.dark }) } : undefined),
    file: (name) => files.get(name),
    load,
    loadWithin: async (waitMs) => {
      const timeout = Promise.withResolvers<false>()
      const timer = setTimeout(() => timeout.resolve(false), waitMs)
      const finished = async () => {
        await load()
        return true
      }
      try {
        return await Promise.race([finished(), timeout.promise])
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
