/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'

const downloadTimeoutMs = 10_000

/**
 * The bytes of a branding file the backend serves at `config/branding/<file>`.
 *
 * Bounded by a signal rather than the client's `timeout`, which stops counting
 * once headers arrive: a body that stalls would otherwise hang the download,
 * and with it the logo slot or the font's retry, for the whole session.
 *
 * @param client - A client for the app backend.
 * @param file - A validated content-addressed file name.
 */
export const fetchBrandingFile = async (client: HttpClient, file: string): Promise<ArrayBuffer> => {
  const response = await client.get(`config/branding/${file}`, { signal: AbortSignal.timeout(downloadTimeoutMs) })
  return response.arrayBuffer()
}
