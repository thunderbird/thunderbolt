/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createContext, useContext } from 'react'
import type { PagePublication } from './page-publications'

/** Conversation-scoped snapshots, derived from messages rather than copied into persistent state. */
export const PagePublicationsContext = createContext<ReadonlyMap<string, PagePublication>>(new Map())

/** Resolve the latest published version without mounting or changing its live page session. */
export const usePagePublication = (pageId: string) => useContext(PagePublicationsContext).get(pageId)
