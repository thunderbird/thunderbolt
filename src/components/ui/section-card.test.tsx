/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'bun:test'
import { render, screen } from '@testing-library/react'
import { SectionCard } from './section-card'

describe('SectionCard', () => {
  it('titles the section with an h2 so it follows the page h1 without skipping a level', () => {
    render(<SectionCard title="Network">body</SectionCard>)
    expect(screen.getByRole('heading', { level: 2, name: 'Network' })).toBeInTheDocument()
  })
})
