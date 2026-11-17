/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { AdminApiError } from '../api/client'
import { InlineError } from './inline-error'

describe('InlineError', () => {
  afterEach(() => {
    cleanup()
  })

  it("shows the error code's message as an alert", () => {
    render(<InlineError error={new AdminApiError(409, 'GROUP_NAME_TAKEN', {})} />)
    expect(screen.getByRole('alert')).toHaveTextContent('A group with this name already exists.')
  })

  it('renders nothing without an error', () => {
    const { container } = render(<InlineError error={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
