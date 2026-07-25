/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@/testing-library'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { CreateItemSurface } from './create-item-surface'

describe('CreateItemSurface', () => {
  afterEach(() => {
    cleanup()
    restoreViewport()
  })

  it('takes desktop row width so the current content shrinks', () => {
    const { container } = render(
      <div className="flex">
        <main>Current screen</main>
        <CreateItemSurface open onClose={() => undefined}>
          <p>Create form</p>
        </CreateItemSurface>
      </div>,
    )

    const surface = container.querySelector('[data-slot="slide-in-panel"]')
    expect(surface).toHaveClass('relative', 'shrink-0', 'overflow-hidden', 'transition-[width]', 'duration-300')
    expect(surface).not.toHaveClass('absolute')
    expect(surface).toHaveStyle({ width: 'clamp(440px, calc(50vw - 128px), 520px)' })
    expect(surface?.firstElementChild).toHaveClass('transition-transform', 'duration-300')
    expect(surface?.firstElementChild).toHaveStyle({ transform: 'translateX(0)' })
    expect(screen.getByText('Current screen')).toBeInTheDocument()
  })

  it('uses the shared full-screen dialog on mobile', () => {
    forceMobileViewport()

    render(
      <CreateItemSurface open onClose={() => undefined}>
        <p>Create form</p>
      </CreateItemSurface>,
    )

    expect(screen.getByRole('dialog')).toContainElement(screen.getByText('Create form'))
  })
})
