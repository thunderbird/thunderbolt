/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, render } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { ReasoningDisplay } from './reasoning-display'

it.each([
  [48, 5951],
  [4000, 2999],
])('reveals reasoning, flushes at %dms, and keeps it visible until the fade delay', (streamingMs, beforeFadeMs) => {
  const text = 'Thinking carefully. '.repeat(80)
  const { container, rerender } = render(<ReasoningDisplay text={text} isStreaming />)
  expect(container.textContent).toBe('')
  act(() => getClock().tick(48))
  expect(container.textContent!.length).toBeGreaterThan(0)
  expect(container.textContent!.length).toBeLessThan(text.length)
  act(() => getClock().tick(streamingMs - 48))
  rerender(<ReasoningDisplay text={text} isStreaming={false} />)
  expect(container.textContent).toBe(text)
  act(() => getClock().tick(beforeFadeMs))
  expect(container.textContent).toBe(text)
  act(() => getClock().tick(1))
  expect(container.textContent).toBe('')
})
