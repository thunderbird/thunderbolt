import { render } from '@testing-library/react'
import { describe, expect, it } from 'bun:test'
import { WeatherForecast, WeatherForecastSkeleton } from './display'
import type { WeatherForecastData } from './lib'

const mockData: WeatherForecastData = {
  location: 'San Francisco, CA, United States',
  days: [
    {
      date: '2026-04-06',
      weather_code: 0,
      temperature_max: 22,
      temperature_min: 12,
      apparent_temperature_max: 24,
      apparent_temperature_min: 10,
      precipitation_sum: 0,
      precipitation_probability_max: 5,
      wind_speed_10m_max: 3.2,
    },
    {
      date: '2026-04-07',
      weather_code: 2,
      temperature_max: 20,
      temperature_min: 14,
      apparent_temperature_max: 19,
      apparent_temperature_min: 15,
      precipitation_sum: 0.5,
      precipitation_probability_max: 15,
      wind_speed_10m_max: 4.1,
    },
    {
      date: '2026-04-08',
      weather_code: 63,
      temperature_max: 18,
      temperature_min: 10,
      apparent_temperature_max: 16,
      apparent_temperature_min: 12,
      precipitation_sum: 8.5,
      precipitation_probability_max: 85,
      wind_speed_10m_max: 6.8,
    },
    {
      date: '2026-04-09',
      weather_code: 73,
      temperature_max: 16,
      temperature_min: 8,
      apparent_temperature_max: 14,
      apparent_temperature_min: 10,
      precipitation_sum: 12.3,
      precipitation_probability_max: 90,
      wind_speed_10m_max: 5.2,
    },
    {
      date: '2026-04-10',
      weather_code: 95,
      temperature_max: 14,
      temperature_min: 6,
      apparent_temperature_max: 12,
      apparent_temperature_min: 8,
      precipitation_sum: 15.7,
      precipitation_probability_max: 95,
      wind_speed_10m_max: 12.4,
    },
    {
      date: '2026-04-11',
      weather_code: 1,
      temperature_max: 19,
      temperature_min: 11,
      apparent_temperature_max: 20,
      apparent_temperature_min: 9,
      precipitation_sum: 0,
      precipitation_probability_max: 10,
      wind_speed_10m_max: 3.8,
    },
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
