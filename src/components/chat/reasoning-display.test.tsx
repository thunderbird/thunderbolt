/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { getClock } from '@/testing-library'
import { act, render } from '@testing-library/react'
import { expect, it } from 'bun:test'
import { ReasoningDisplay } from './reasoning-display'

it('reveals reasoning progressively, then flushes before its existing fade-out', () => {
  const text = 'Thinking carefully. '.repeat(80)
  const { container, rerender } = render(<ReasoningDisplay text={text} isStreaming instanceKey="reasoning-0" />)
  expect(container.textContent).toBe('')
  act(() => getClock().tick(48))
  expect(container.textContent!.length).toBeGreaterThan(0)
  expect(container.textContent!.length).toBeLessThan(text.length)
  rerender(<ReasoningDisplay text={text} isStreaming={false} instanceKey="reasoning-0" />)
  expect(container.textContent).toBe(text)
})
