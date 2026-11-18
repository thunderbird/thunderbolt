/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { MemoryRouter } from 'react-router'
import { BreakGlassBanner, hasBreakGlassWarning } from './break-glass-banner'

describe('BreakGlassBanner', () => {
  afterEach(() => {
    cleanup()
  })

  it('reads the warning from a role change response', () => {
    expect(hasBreakGlassWarning({ warning: 'NO_LOCAL_ADMIN' })).toBe(true)
    expect(hasBreakGlassWarning({})).toBe(false)
    expect(hasBreakGlassWarning(undefined)).toBe(false)
  })

  it('links to the break-glass page', () => {
    render(
      <MemoryRouter>
        <BreakGlassBanner />
      </MemoryRouter>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('No admin can sign in without your identity provider')
    expect(screen.getByRole('link', { name: 'Review break-glass access' })).toHaveAttribute(
      'href',
      '/admin/break-glass',
    )
  })
})
