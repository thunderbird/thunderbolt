/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect } from 'react'
import { afterPaint } from '@/lib/after-paint'
import { markContentReady } from '@/lib/init-timing'
import { trackEvent } from '@/lib/posthog'
import { preloadChatMessageList } from './chat-messages-loader'

/** Placed inside the message Suspense boundary so a lazy message list cannot mark ready early. */
export const ChatContentReady = () => {
  useEffect(
    () =>
      afterPaint(() => {
        const payload = markContentReady()
        if (payload) {
          trackEvent('app_content_ready', payload)
        }
        // Warm blank chats after their composer renders, including embedded chats.
        // Existing conversations have already loaded this memoized module.
        preloadChatMessageList()
      }),
    [],
  )
  return null
}
