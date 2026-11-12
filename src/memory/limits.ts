/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { graphemeSegmenter } from '@/lib/segmenter'

export const maxMemoryBytes = 6 * 1024
export const maxMemoryContextBytes = 8 * 1024
export const maxMemoryReadResultBytes = 7 * 1024
export const maxMemoryReadBytesPerTurn = 24 * 1024
export const maxMemoryToolCalls = 12

const encoder = new TextEncoder()

/** Invalid documents never reach storage, even when a caller bypasses the editor. */
export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryValidationError'
  }
}

/** Count UTF-8 bytes, giving every model the same conservative context bound. */
export const memoryByteLength = (text: string): number => encoder.encode(text).length

/** Count visible characters, including combined accents and emoji, for the settings display. */
export const memoryCharacterLength = (content: string): number => {
  const segmenter = graphemeSegmenter()
  return segmenter ? Array.from(segmenter.segment(content)).length : Array.from(content).length
}

/** Report the size of the entire freeform document without changing its formatting. */
export const getMemoryUsage = (content: string) => ({
  bytes: memoryByteLength(content),
  characters: memoryCharacterLength(content),
})

/** Validate the complete replacement; an empty document intentionally clears memory. */
export const validateMemoryContent = (content: string): void => {
  if (memoryByteLength(content) > maxMemoryBytes) {
    throw new MemoryValidationError('Memory can contain at most 6 KiB. Shorten or compact it first.')
  }
}
