/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import '@testing-library/jest-dom'
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { EmailChipInput } from './email-chip-input'

const placeholderText = 'Enter emails…'

const Harness = ({ initial = [] as string[] }: { initial?: string[] }) => {
  const [value, setValue] = useState<string[]>(initial)
  return (
    <>
      <EmailChipInput value={value} onChange={setValue} placeholder={placeholderText} />
      <div data-testid="value-json">{JSON.stringify(value)}</div>
    </>
  )
}

const findInput = (initial: string[] = []): HTMLInputElement => {
  // Placeholder only renders when value is empty; fall back to the email
  // autocomplete attribute (the input always has it) when we seeded chips.
  if (initial.length === 0) {
    return screen.getByPlaceholderText(placeholderText) as HTMLInputElement
  }
  return screen.getByDisplayValue('') as HTMLInputElement
}

const typeAndCommit = (input: HTMLInputElement, text: string, commitKey: 'Enter' | ',' | ' ') => {
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: commitKey })
}

describe('EmailChipInput', () => {
  afterEach(() => {
    cleanup()
  })

  it('commits a valid email as a chip on Enter', () => {
    render(<Harness />)
    const input = findInput()
    typeAndCommit(input, 'alice@test.com', 'Enter')
    expect(screen.getByTestId('email-chip-alice@test.com')).toBeInTheDocument()
    expect(screen.getByTestId('value-json')).toHaveTextContent('["alice@test.com"]')
    expect(input).toHaveValue('')
  })

  it('commits on comma', () => {
    render(<Harness />)
    typeAndCommit(findInput(), 'a@test.com', ',')
    expect(screen.getByTestId('email-chip-a@test.com')).toBeInTheDocument()
  })

  it('commits on space', () => {
    render(<Harness />)
    typeAndCommit(findInput(), 'b@test.com', ' ')
    expect(screen.getByTestId('email-chip-b@test.com')).toBeInTheDocument()
  })

  it('normalizes to lowercase + trim', () => {
    render(<Harness />)
    typeAndCommit(findInput(), '  Mixed@TEST.com  ', 'Enter')
    expect(screen.getByTestId('email-chip-mixed@test.com')).toBeInTheDocument()
    expect(screen.getByTestId('value-json')).toHaveTextContent('["mixed@test.com"]')
  })

  it('does not commit invalid email; shows error; leaves text in input', () => {
    render(<Harness />)
    const input = findInput()
    typeAndCommit(input, 'not-an-email', 'Enter')
    expect(screen.queryByTestId(/email-chip-/)).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/not a valid email/i)
    expect(input).toHaveValue('not-an-email')
  })

  it('clears error when the user types again', () => {
    render(<Harness />)
    const input = findInput()
    typeAndCommit(input, 'bad', 'Enter')
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'badx' } })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('dedupes within the chip list', () => {
    render(<Harness initial={['alice@test.com']} />)
    typeAndCommit(findInput(['alice@test.com']), 'alice@test.com', 'Enter')
    expect(screen.getAllByTestId(/email-chip-/)).toHaveLength(1)
  })

  it('backspace on empty input removes the last chip', () => {
    render(<Harness initial={['a@test.com', 'b@test.com']} />)
    fireEvent.keyDown(findInput(['a@test.com', 'b@test.com']), { key: 'Backspace' })
    expect(screen.queryByTestId('email-chip-b@test.com')).not.toBeInTheDocument()
    expect(screen.getByTestId('email-chip-a@test.com')).toBeInTheDocument()
  })

  it('does not remove chips when backspacing with text in input', () => {
    render(<Harness initial={['a@test.com', 'b@test.com']} />)
    const input = findInput(['a@test.com', 'b@test.com'])
    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(screen.getByTestId('email-chip-a@test.com')).toBeInTheDocument()
    expect(screen.getByTestId('email-chip-b@test.com')).toBeInTheDocument()
  })

  it('clicking the chip × removes that chip', () => {
    render(<Harness initial={['a@test.com', 'b@test.com']} />)
    fireEvent.click(screen.getByLabelText('Remove a@test.com'))
    expect(screen.queryByTestId('email-chip-a@test.com')).not.toBeInTheDocument()
    expect(screen.getByTestId('email-chip-b@test.com')).toBeInTheDocument()
  })

  it('paste of comma-separated emails commits all valid + reports invalid', () => {
    render(<Harness />)
    const input = findInput()
    fireEvent.paste(input, {
      clipboardData: {
        getData: () => 'one@test.com, two@test.com; not-email three@test.com',
      },
    })
    expect(screen.getByTestId('email-chip-one@test.com')).toBeInTheDocument()
    expect(screen.getByTestId('email-chip-two@test.com')).toBeInTheDocument()
    expect(screen.getByTestId('email-chip-three@test.com')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/not-email/)
  })

  it('commits the current draft on blur', () => {
    render(<Harness />)
    const input = findInput()
    fireEvent.change(input, { target: { value: 'blur@test.com' } })
    fireEvent.blur(input)
    expect(screen.getByTestId('email-chip-blur@test.com')).toBeInTheDocument()
  })
})
