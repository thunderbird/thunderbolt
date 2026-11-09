/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { lazy, Suspense, useRef, type ComponentProps } from 'react'

// The dialog brings the share service, the share crypto and the snapshot
// schemas; the header and sidebar that open it are in the entry bundle.
const ShareChatDialogImpl = lazy(async () => {
  const module = await import('./share-chat-dialog')
  return { default: module.ShareChatDialog }
})

/**
 * The share dialog, loaded the first time it opens. It stays mounted after
 * that, so closing it animates like any other dialog.
 */
export const LazyShareChatDialog = (props: ComponentProps<typeof ShareChatDialogImpl>) => {
  const hasOpened = useRef(false)
  hasOpened.current ||= props.open
  if (!hasOpened.current) {
    return null
  }
  return (
    <Suspense fallback={null}>
      <ShareChatDialogImpl {...props} />
    </Suspense>
  )
}
