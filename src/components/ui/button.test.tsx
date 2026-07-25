/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'bun:test'

import { Button } from './button'

afterEach(cleanup)

describe('Button', () => {
  it('reserves matching border geometry for gradient and outlined buttons', () => {
    render(
      <>
        <Button>Save</Button>
        <Button variant="outline">Cancel</Button>
      </>,
    )

    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('border', 'border-transparent')
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('border')
  })

  it('disables the button and exposes a busy state with its loading label', () => {
    render(
      <Button isLoading loadingLabel="Saving…">
        Save
      </Button>,
    )

    const button = screen.getByRole('button', { name: 'Saving…' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveClass('disabled:[background-image:var(--gradient-brand)]')
    expect(button.querySelector('.animate-spin')).toBeInTheDocument()
  })

  it('keeps ordinary disabled primary buttons neutral', () => {
    render(<Button disabled>Save</Button>)

    expect(screen.getByRole('button', { name: 'Save' })).not.toHaveClass(
      'disabled:[background-image:var(--gradient-brand)]',
    )
  })
})
