/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'

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

  it('does not apply the loading state to non-primary variants', () => {
    render(
      <Button variant="destructive" isLoading loadingLabel="Deleting…">
        Delete
      </Button>,
    )

    expect(screen.getByRole('button', { name: 'Deleting…' })).not.toHaveClass(
      'disabled:[background-image:var(--gradient-brand)]',
    )
  })

  it('slots onto a single anchor child with asChild', () => {
    render(
      <Button asChild>
        <a href="https://example.com">Install guide</a>
      </Button>,
    )

    const link = screen.getByRole('link', { name: 'Install guide' })
    expect(link).toHaveAttribute('data-slot', 'button')
  })

  it('makes a loading slotted link inert before invoking its click handler', () => {
    const onClick = mock(() => {})
    render(
      <Button asChild isLoading onClick={onClick}>
        <a href="https://example.com">Install guide</a>
      </Button>,
    )

    const link = screen.getByRole('link', { name: 'Install guide' })
    fireEvent.click(link)

    expect(link).toHaveAttribute('aria-disabled', 'true')
    expect(link).toHaveAttribute('aria-busy', 'true')
    expect(link).toHaveAttribute('tabindex', '-1')
    expect(onClick).not.toHaveBeenCalled()
  })
})
