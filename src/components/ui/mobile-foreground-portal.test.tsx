/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { forceMobileViewport, restoreViewport } from '@/test-utils/viewport'
import { MobileForegroundPortalProvider } from './mobile-foreground-portal'
import { PageCreateAction } from './page-create-action'
import { PageHeader } from './page-header'
import { PageSearch } from './page-search'

afterEach(() => {
  cleanup()
  restoreViewport()
})

describe('MobileForegroundPortalProvider', () => {
  it('keeps fixed page chrome inside the movable foreground', () => {
    forceMobileViewport()
    render(
      <MobileForegroundPortalProvider>
        <PageHeader title="Agents">
          <PageCreateAction label="New Agent" onClick={() => {}} />
          <PageSearch onSearch={() => {}}>
            <PageSearch.Button />
          </PageSearch>
        </PageHeader>
      </MobileForegroundPortalProvider>,
    )

    const portal = document.querySelector('[data-slot="mobile-foreground-portal"]')
    expect(portal).toContainElement(screen.getByRole('heading', { name: 'Agents' }))
    expect(portal).toContainElement(screen.getByRole('button', { name: 'New Agent' }))
    expect(portal).toContainElement(screen.getByRole('button', { name: 'Search' }))
  })
})
