/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, expect, it } from 'bun:test'
import { isOpfsAvailable } from './platform'

const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage')
afterEach(() => {
  if (originalStorage) {
    Object.defineProperty(navigator, 'storage', originalStorage)
  } else {
    Reflect.deleteProperty(navigator, 'storage')
  }
})

it('simultaneous storage probes clean up only their own files', async () => {
  const files = new Set<string>()
  const names: string[] = []
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      getDirectory: async () => ({
        getFileHandle: async (name: string) => {
          files.add(name)
          names.push(name)
        },
        removeEntry: async (name: string) => {
          if (!files.delete(name)) {
            throw new DOMException('Another probe already removed this file', 'NotFoundError')
          }
        },
      }),
    },
  })
  // Test setup freezes time: Date.now()-based names collide deterministically.
  const results = await Promise.all([isOpfsAvailable(), isOpfsAvailable(), isOpfsAvailable()])
  expect(results).toEqual([true, true, true])
  expect(new Set(names).size).toBe(3)
  expect(files.size).toBe(0)
})
