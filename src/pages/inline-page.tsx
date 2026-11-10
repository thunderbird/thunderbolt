/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'
import type { PageDefinition } from '@shared/page-protocol'
import { EmbeddedErrorStrip } from '@/components/embedded'
import { usePageStore } from './page-store'
import { PageSlot } from './page-slot'

/** Register an inline artifact once; its live iframe remains owned by the permanent page host. */
export const InlinePage = ({ page, enabled }: { page: PageDefinition; enabled: boolean }) => {
  const session = usePageStore((state) => state.sessions.find((session) => session.page.id === page.id))
  useEffect(() => {
    if (enabled) {
      usePageStore.getState().ensure(page, {
        presentation: 'inline',
        chatThreadId: page.source.kind === 'html' ? page.source.artifact?.chatThreadId : null,
      })
    }
  }, [enabled, page])
  return session ? (
    <>
      {session.error && <EmbeddedErrorStrip message={session.error} />}
      <PageSlot sessionId={session.id} mode="inline" height={session.height} />
    </>
  ) : (
    <div style={{ height: 400 }} />
  )
}
