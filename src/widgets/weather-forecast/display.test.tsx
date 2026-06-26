/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { WeatherForecast, WeatherForecastSkeleton } from './display'
import type { WeatherForecastData } from './lib'

const mockData: WeatherForecastData = {
  location: 'San Francisco, CA, United States',
  days: [
    { date: '2026-04-06', weather_code: 0, temperature_max: 22 },
    { date: '2026-04-07', weather_code: 2, temperature_max: 20 },
    { date: '2026-04-08', weather_code: 63, temperature_max: 18 },
    { date: '2026-04-09', weather_code: 73, temperature_max: 16 },
    { date: '2026-04-10', weather_code: 95, temperature_max: 14 },
    { date: '2026-04-11', weather_code: 1, temperature_max: 19 },
  ],
  temperature_unit: 'c',
}

describe('WeatherForecast', () => {
  it('renders correctly with 6 days of data', () => {
    const { container } = render(<WeatherForecast {...mockData} />)
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('renders correctly in Fahrenheit', () => {
    const { container } = render(<WeatherForecast {...mockData} temperature_unit="f" />)
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('renders correctly with a single day', () => {
    const singleDay: WeatherForecastData = {
      ...mockData,
      days: [mockData.days[0]],
    }
    const { container } = render(<WeatherForecast {...singleDay} />)
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('renders skeleton when no days provided', () => {
    const { container } = render(<WeatherForecast {...mockData} days={[]} />)
    expect(container.innerHTML).toMatchSnapshot()
  })
})

describe('WeatherForecastSkeleton', () => {
  it('renders correctly', () => {
    const { container } = render(<WeatherForecastSkeleton />)
    expect(container.innerHTML).toMatchSnapshot()
  })
})
