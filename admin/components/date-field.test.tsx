/* UNLICENSED — license TBD. This file is not licensed under MPL-2.0.
 * All rights reserved. See admin/LICENSE.
 * Enterprise support and licensing: contact info@thunderbolt.io. */

import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { firstDayOfWeek } from '@/components/ui/calendar'
import { getFormatters } from '@/i18n/format'
import { pickDate } from '../test-utils'
import { DateField, toLocalDay } from './date-field'

const renderField = (props: { value?: string; min?: string } = {}) => {
  const onChange = mock((_: string) => {})
  render(
    <>
      <label htmlFor="day">Day</label>
      <DateField id="day" value={props.value ?? ''} min={props.min} placeholder="Any date" onChange={onChange} />
    </>,
  )
  return onChange
}

describe('DateField', () => {
  afterEach(() => {
    cleanup()
  })

  it('shows the placeholder until a day is picked, then reports the local day', () => {
    const onChange = renderField()
    expect(screen.getByLabelText('Day')).toHaveTextContent('Any date')

    const today = new Date()
    const next = new Date(today.getFullYear(), today.getMonth() + 2, 15)
    pickDate('Day', toLocalDay(next))

    expect(onChange).toHaveBeenLastCalledWith(toLocalDay(next))
  })

  it('shows a set day in the locale format and clears it', () => {
    const onChange = renderField({ value: '2026-11-17' })
    expect(screen.getByLabelText('Day')).toHaveTextContent('Nov 17, 2026')

    fireEvent.click(screen.getByLabelText('Day'))
    fireEvent.click(screen.getByRole('button', { name: 'Clear date' }))

    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('tells a screen reader which day is selected and which is today', () => {
    renderField({ value: '2026-11-17' })
    fireEvent.click(screen.getByLabelText('Day'))
    expect(screen.getByRole('button', { name: 'Nov 17, 2026, selected' })).toBeInTheDocument()

    cleanup()
    renderField()
    fireEvent.click(screen.getByLabelText('Day'))
    const today = getFormatters('en').date(new Date())
    expect(screen.getByRole('button', { name: `Today, ${today}` })).toBeInTheDocument()
  })

  it('disables the days before the minimum', () => {
    renderField({ value: '2026-11-17', min: '2026-11-10' })
    fireEvent.click(screen.getByLabelText('Day'))

    expect(screen.getByRole('button', { name: 'Nov 9, 2026' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Nov 10, 2026' })).toBeEnabled()
  })
})

describe('firstDayOfWeek', () => {
  it("starts the week where the locale's region starts it", () => {
    expect(firstDayOfWeek('en-US')).toBe(0)
    expect(firstDayOfWeek('de')).toBe(1)
  })
})

describe('toLocalDay', () => {
  it('reads the local calendar day, not the UTC one', () => {
    expect(toLocalDay(new Date(2026, 0, 5, 23, 30))).toBe('2026-01-05')
  })
})
