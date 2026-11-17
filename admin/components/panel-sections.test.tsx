/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { PanelSections } from './panel-sections'

describe('PanelSections', () => {
  afterEach(() => {
    cleanup()
  })

  it('switches to the chosen section', () => {
    const onChange = mock((_value: 'sso' | 'scim') => {})
    render(
      <PanelSections
        label="Connection sections"
        value="sso"
        onChange={onChange}
        sections={[
          { id: 'sso', label: 'Single sign-on' },
          { id: 'scim', label: 'SCIM' },
        ]}
      />,
    )
    expect(screen.getByRole('radiogroup', { name: 'Connection sections' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'SCIM' }))
    expect(onChange).toHaveBeenCalledWith('scim')
  })
})
