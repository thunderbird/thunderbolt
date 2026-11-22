/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
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

  it('says no admin can sign in without the identity provider', () => {
    render(<BreakGlassBanner />)
    expect(screen.getByRole('alert')).toHaveTextContent('No admin can sign in without your identity provider')
  })
})
