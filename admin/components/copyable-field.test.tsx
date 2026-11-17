/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'
import { CopyableField } from './copyable-field'

describe('CopyableField', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the whole value in a named field beside a named copy button', () => {
    render(<CopyableField label="SCIM token" copyLabel="Copy the SCIM token" value="scim-token-123" />)
    expect(screen.getByRole('textbox', { name: 'SCIM token' })).toHaveValue('scim-token-123')
    expect(screen.getByRole('button', { name: 'Copy the SCIM token' })).toBeInTheDocument()
  })
})
