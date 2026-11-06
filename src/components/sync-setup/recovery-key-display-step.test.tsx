/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { RecoveryKeyDisplayStep } from './recovery-key-display-step'

// What a browser that denies clipboard-write does, as Playwright's default context does.
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText: mock(() => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'))) },
  configurable: true,
})

afterEach(cleanup)

describe('RecoveryKeyDisplayStep', () => {
  it('finishes when the clipboard refuses the best-effort clear', async () => {
    const onDone = mock(() => {})
    render(<RecoveryKeyDisplayStep recoveryKey={'word '.repeat(24).trim()} onDone={onDone} />)

    fireEvent.click(screen.getByRole('checkbox'))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    })

    expect(onDone).toHaveBeenCalledTimes(1)
  })
})
