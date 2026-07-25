/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useEffect, useRef } from 'react'

/**
 * Returns a ref that focuses its element on mount, deferred one animation
 * frame. Create-style forms attach it to their first field so the user lands
 * ready to type.
 *
 * The deferral matters on mobile: these forms open inside the responsive
 * modal shell, whose focus management runs in its own mount effect and would
 * override a synchronous (or native `autoFocus`) focus. Waiting a frame lets
 * this focus win — and programmatic focus raises the keyboard in the native
 * apps (see the WKContentView swizzle in main.mm).
 *
 * Pass `enabled: false` to skip, e.g. edit variants of a form that must not
 * steal focus from a user who opened a record to change one field.
 */
export const useAutofocusOnMount = <T extends HTMLElement>(enabled = true) => {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }
    const frame = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [enabled])

  return ref
}
