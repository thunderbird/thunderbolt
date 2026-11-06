/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it, spyOn } from 'bun:test'
import * as messagesLoader from './chat-messages-loader'

let loadMessages: ReturnType<typeof spyOn> | undefined

afterEach(() => {
  loadMessages?.mockRestore()
})

it('drops a failed warm-up instead of leaving an unhandled rejection', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => unhandled.push(reason)
  process.on('unhandledRejection', onUnhandled)
  loadMessages = spyOn(messagesLoader, 'loadChatMessageList').mockImplementation(() =>
    Promise.reject(new TypeError('error loading dynamically imported module')),
  )

  messagesLoader.preloadChatMessageList()
  await new Promise((resolve) => setImmediate(resolve))
  process.off('unhandledRejection', onUnhandled)

  expect(loadMessages).toHaveBeenCalledTimes(1)
  expect(unhandled).toEqual([])
})
