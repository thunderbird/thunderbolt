/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import NotFound from './not-found'

/**
 * NotFound uses <Trans> from @lingui/react/macro. In bun tests the macro is
 * replaced by the identity harness (src/i18n/identity-macros.tsx), so the
 * English source text must render with no I18nProvider in the tree — the
 * guarantee that keeps existing getByText assertions passing (THU-806).
 */
describe('NotFound', () => {
  it('renders the source-locale text without an i18n provider', () => {
    render(
      <MemoryRouter>
        <NotFound />
      </MemoryRouter>,
    )

    expect(screen.getByText('Not Found')).toBeInTheDocument()
    expect(screen.getByText('Back to App')).toBeInTheDocument()
  })
})
