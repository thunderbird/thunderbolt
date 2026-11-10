/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { verifyArtifactHtml } from '@/artifacts/verify-html'
import type { SavedPage } from './saved-page'
import { usePageStore } from './page-store'

/** Imported/synced snapshots must pass the same verification as freshly generated HTML. */
export const restoreSavedPage = async (page: SavedPage, signal?: AbortSignal): Promise<string> => {
  signal?.throwIfAborted()
  const existing = usePageStore.getState().sessions.find((session) => session.page.id === page.id)
  if (existing) {
    return existing.id
  }
  if (page.source.kind === 'html') {
    const result = await verifyArtifactHtml(page.source.html)
    signal?.throwIfAborted()
    if (!result.ok) {
      throw new Error('This saved HTML page could not be verified.')
    }
  }
  signal?.throwIfAborted()
  return usePageStore.getState().ensure(page, { chrome: page.chrome, presentation: 'expanded' })
}
