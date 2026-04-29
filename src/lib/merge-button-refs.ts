/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* 
    This function merges multiple refs into a single ref callback.
    It ensures that the value is assigned to each ref, whether it's a function or a mutable ref object.
    This is useful when you need to merge external refs with an internal ref.
*/

import type { LegacyRef, MutableRefObject, RefCallback } from 'react'

export const mergeButtonRefs = <T extends HTMLButtonElement>(
  refs: Array<MutableRefObject<T> | LegacyRef<T>>,
): RefCallback<T> => {
  return (value) => {
    for (const ref of refs) {
      if (typeof ref === 'function') {
        ref(value)
      } else if (ref != null) {
        ;(ref as MutableRefObject<T | null>).current = value
      }
    }
  }
}
