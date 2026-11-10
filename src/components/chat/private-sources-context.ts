/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext } from 'react'
import type { SourceMetadata } from '@/types/source'

export const PrivateSourcesContext = createContext(false)

/** Follow-up replies can reuse private evidence without producing their own source registry. */
export const usePrivateSources = (sources?: SourceMetadata[]) => {
  const inherited = useContext(PrivateSourcesContext)
  return inherited || sources?.some((source) => source.allowRemoteImages === false) === true
}
