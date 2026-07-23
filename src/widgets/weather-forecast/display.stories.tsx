/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Meta, StoryObj } from '@storybook/react-vite'

import { WeatherForecast } from './display'
import type { WeatherForecastData } from './lib'

const forecast: WeatherForecastData = {
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

const meta = {
  title: 'Widgets/WeatherForecast',
  component: WeatherForecast,
  parameters: {
    layout: 'padded',
  },
  args: forecast,
} satisfies Meta<typeof WeatherForecast>

export default meta
type Story = StoryObj<typeof meta>

export const SixDayForecast: Story = {}

export const Mobile: Story = {
  parameters: {
    viewport: { defaultViewport: 'mobile1' },
  },
}

export const SingleDay: Story = {
  args: {
    days: [forecast.days[0]],
  },
}

export const Loading: Story = {
  args: {
    days: [],
  },
}
