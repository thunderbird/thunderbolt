/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { PageDefinition } from '@shared/page-protocol'
import { getDb } from '@/db/database'
import { pageController } from './page-controller'
import { usePageStore } from './page-store'
import { updatePinnedPageSource } from './saved-pages'

export type GeneratedPagePresentation = 'sidebar' | 'inline'
export type PagePublication = {
  sessionId: string
  updated: boolean
  presentation: GeneratedPagePresentation
}
export type PublishPageOptions = {
  presentation?: GeneratedPagePresentation
  chatThreadId?: string
  signal?: AbortSignal
}

/** Publish verified HTML explicitly; replaying a transcript never calls this mutation. */
export const publishGeneratedPage = async (
  page: PageDefinition,
  options: PublishPageOptions = {},
): Promise<PagePublication> => {
  options.signal?.throwIfAborted()
  const existing = usePageStore.getState().sessions.find((session) => session.page.id === page.id)
  if (page.source.kind !== 'html' || (existing && existing.page.source.kind !== 'html')) {
    throw new Error('Generated pages can only replace an HTML page.')
  }
  await updatePinnedPageSource(getDb(), page)
  options.signal?.throwIfAborted()
  const sessionId = pageController.publishHtml(page, options)
  const session = usePageStore.getState().sessions.find((item) => item.id === sessionId)!
  return {
    sessionId,
    updated: !!existing,
    presentation: session.presentation === 'inline' ? 'inline' : 'sidebar',
  }
}
