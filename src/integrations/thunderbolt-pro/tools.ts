/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { HttpClient } from '@/lib/http'
import { http } from '@/lib/http'
import type { SourceMetadata } from '@/types/source'
import { fetchContent, fetchLinkPreview, search } from './api'
import { createConfigs as createPortableConfigs, type WebToolApi } from './tools-core'

export { fetchContent, search } from './api'
export { fetchContentSchema, searchSchema } from './schemas'
export type { FetchContentParams, SearchParams, SearchResultData } from './schemas'
export type { WebToolApi } from './tools-core'

/** Bind the portable web tools to the browser app's authenticated HTTP client. */
export const createConfigs = (
  httpClient: HttpClient,
  sourceCollector?: SourceMetadata[],
  api: WebToolApi = { search, fetchContent, fetchLinkPreview },
) => createPortableConfigs(httpClient, sourceCollector, api)

/** @deprecated Use createConfigs with an injected authenticated client. */
export const configs = createConfigs(http)
