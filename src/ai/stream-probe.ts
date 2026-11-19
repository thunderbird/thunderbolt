/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { streamText } from 'ai'

/** Consume a streaming probe completely, propagating errors without logging authenticated provider responses. */
export const streamProbe = async (options: Parameters<typeof streamText>[0]): Promise<string> => {
  const result = streamText({ ...options, onError: () => {} })
  const text: string[] = []
  for await (const part of result.fullStream) {
    if (part.type === 'error') {
      throw part.error
    }
    if (part.type === 'text-delta') {
      text.push(part.text)
    }
  }
  options.abortSignal?.throwIfAborted()
  const reason = await result.finishReason
  if (reason === 'other' || reason === 'error') {
    throw new Error('Model probe did not complete')
  }
  return text.join('')
}
