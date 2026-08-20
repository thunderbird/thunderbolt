/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { ReasoningDisplay } from './reasoning-display'

describe('ReasoningDisplay', () => {
  afterEach(cleanup)

  it('reserves height while the reasoning is shown (streaming)', () => {
    const { container } = render(<ReasoningDisplay text="thinking…" isStreaming instanceKey="k1" />)
    expect((container.firstChild as HTMLElement).className).toContain('min-h-[200px]')
  })

  // A stopped reasoning-only turn never gets a text part to unmount this display,
  // so an unconditional reserve leaves a permanent blank gap below "Thought for…".
  it('does not reserve height once the reasoning has settled', () => {
    const { container } = render(<ReasoningDisplay text="thinking…" isStreaming={false} instanceKey="k2" />)
    expect((container.firstChild as HTMLElement).className).not.toContain('min-h-[200px]')
  })
})
