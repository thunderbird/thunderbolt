/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { brandingLogoTypes, isBrandingLogoType, type BrandingLogoFile } from '@shared/branding'
import {
  contentName,
  fetchOk,
  PermanentDownloadError,
  readCapped,
  type BrandingFetch,
  type BrandingFile,
} from './download'

// The client inlines the logo as a base64 `data:` URL (and the favicon), so it
// stays small; real logos are a few KB.
const maxLogoBytes = 512 * 1024

/**
 * Download one operator logo. Only SVG, PNG, WebP and JPEG are kept, capped in
 * size. An SVG served from the API origin could run script if opened directly,
 * so the route that serves it sandboxes it (see `config.ts`); the client only
 * ever renders it through `<img>` and the favicon link.
 *
 * @param url - An https URL from `BRANDING`.
 * @param fetchFn - The fetch to download with; `startServer` passes the SSRF-safe one.
 * @throws {PermanentDownloadError} For a final 4xx, a wrong type, an empty or oversized file; a plain error for anything retryable.
 */
export const downloadLogo = async (
  url: string,
  fetchFn: BrandingFetch,
): Promise<{ logo: BrandingLogoFile; file: BrandingFile }> => {
  const response = await fetchOk(url, fetchFn)
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!isBrandingLogoType(type)) {
    await response.body?.cancel()
    throw new PermanentDownloadError(`Logo must be SVG, PNG, WebP or JPEG; got "${type || 'no content type'}"`)
  }
  const bytes = await readCapped(response, maxLogoBytes)
  if (bytes.byteLength === 0) {
    throw new PermanentDownloadError('Logo is empty')
  }
  const name = await contentName(bytes, brandingLogoTypes[type])
  return { logo: { file: name, type }, file: { name, bytes, type } }
}
