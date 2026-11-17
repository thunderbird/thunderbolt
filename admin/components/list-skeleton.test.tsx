/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { ListSkeleton } from './list-skeleton'

describe('ListSkeleton', () => {
  afterEach(() => {
    cleanup()
  })

  it('announces loading with the requested rows', () => {
    render(<ListSkeleton rows={3} />)
    const status = screen.getByRole('status', { name: 'Loading' })
    expect(status.children).toHaveLength(3)
  })
})
