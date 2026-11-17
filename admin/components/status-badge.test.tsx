/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { StatusBadge } from './status-badge'

describe('StatusBadge', () => {
  afterEach(() => {
    cleanup()
  })

  it('renders its label in its tone', () => {
    render(<StatusBadge tone="danger">Blocked</StatusBadge>)
    expect(screen.getByText('Blocked')).toHaveAttribute('data-tone', 'danger')
  })
})
