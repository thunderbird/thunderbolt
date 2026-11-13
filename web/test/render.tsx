/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach } from 'bun:test'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

const unmounts = new Set<() => void>()

// bunfig.toml preloads this file, so the hook runs after every test in every file.
afterEach(() => unmounts.forEach((unmount) => unmount()))

/**
 * Render a component into the document for a test.
 *
 * @returns The element it was rendered into, `rerender` to render another tree in its place, and
 * `unmount` for tests about unmounting. Anything still mounted is removed when the test ends.
 */
export const render = (node: ReactNode) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const unmount = () => {
    unmounts.delete(unmount)
    act(() => root.unmount())
    container.remove()
  }
  unmounts.add(unmount)
  act(() => root.render(node))
  return { container, rerender: (next: ReactNode) => act(() => root.render(next)), unmount }
}
