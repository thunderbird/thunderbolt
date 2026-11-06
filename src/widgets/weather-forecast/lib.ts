/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'
import { z } from 'zod'

import { toDate } from '@/i18n/format'

const WeatherDaySchema = z.object({
  date: z.string(),
  weather_code: z.number(),
  temperature_max: z.number(),
})

export const WeatherForecastDataSchema = z.object({
  location: z.string(),
  days: z.array(WeatherDaySchema).min(1).max(7),
  temperature_unit: z.enum(['c', 'f']),
})

export type WeatherDay = z.infer<typeof WeatherDaySchema>
export type WeatherForecastData = z.infer<typeof WeatherForecastDataSchema>

export type WeatherMetadata = {
  /** A descriptor, not a string: the table is built where the locale may not be
   *  active yet, so the display resolves it with `i18n._()`. */
  description: MessageDescriptor
  icon: string
}

/** A bare `YYYY-MM-DD` day carries no time, so treat the forecast as daytime. */
const isDayTime = (dateString: string): boolean => {
  const hour = dateString.includes('T') ? toDate(dateString).getHours() : 12
  return hour >= 6 && hour < 18
}

export const getWeatherMetadata = (code: number, dateString: string): WeatherMetadata => {
  const isDay = isDayTime(dateString)

  const weatherMetadata: Record<number, { description: MessageDescriptor; dayIcon: string; nightIcon: string }> = {
    0: {
      description: msg`Clear sky`,
      dayIcon: '/meteocons/clear-day.svg',
      nightIcon: '/meteocons/clear-night.svg',
    },
    1: {
      description: msg`Mainly clear`,
      dayIcon: '/meteocons/partly-cloudy-day.svg',
      nightIcon: '/meteocons/partly-cloudy-night.svg',
    },
    2: {
      description: msg`Partly cloudy`,
      dayIcon: '/meteocons/partly-cloudy-day.svg',
      nightIcon: '/meteocons/partly-cloudy-night.svg',
    },
    3: {
      description: msg`Overcast`,
      dayIcon: '/meteocons/overcast-day.svg',
      nightIcon: '/meteocons/overcast-night.svg',
    },
    45: {
      description: msg`Foggy`,
      dayIcon: '/meteocons/fog-day.svg',
      nightIcon: '/meteocons/fog-night.svg',
    },
    48: {
      description: msg`Depositing rime fog`,
      dayIcon: '/meteocons/fog-day.svg',
      nightIcon: '/meteocons/fog-night.svg',
    },
    51: {
      description: msg`Light drizzle`,
      dayIcon: '/meteocons/partly-cloudy-day-drizzle.svg',
      nightIcon: '/meteocons/partly-cloudy-night-drizzle.svg',
    },
    53: {
      description: msg`Moderate drizzle`,
      dayIcon: '/meteocons/partly-cloudy-day-drizzle.svg',
      nightIcon: '/meteocons/partly-cloudy-night-drizzle.svg',
    },
    55: {
      description: msg`Dense drizzle`,
      dayIcon: '/meteocons/partly-cloudy-day-drizzle.svg',
      nightIcon: '/meteocons/partly-cloudy-night-drizzle.svg',
    },
    56: {
      description: msg`Light freezing drizzle`,
      dayIcon: '/meteocons/partly-cloudy-day-sleet.svg',
      nightIcon: '/meteocons/partly-cloudy-night-sleet.svg',
    },
    57: {
      description: msg`Dense freezing drizzle`,
      dayIcon: '/meteocons/partly-cloudy-day-sleet.svg',
      nightIcon: '/meteocons/partly-cloudy-night-sleet.svg',
    },
    61: {
      description: msg`Slight rain`,
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    63: {
      description: msg`Moderate rain`,
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    65: {
      description: msg`Heavy rain`,
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    66: {
      description: msg`Light freezing rain`,
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    67: {
      description: msg`Heavy freezing rain`,
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    71: {
      description: msg`Slight snow fall`,
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    73: {
      description: msg`Moderate snow fall`,
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    75: {
      description: msg`Heavy snow fall`,
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    77: {
      description: msg`Snow grains`,
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    80: {
      description: msg`Slight rain showers`,
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    81: {
      description: msg`Moderate rain showers`,
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    82: {
      description: msg`Violent rain showers`,
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    85: {
      description: msg`Slight snow showers`,
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    86: {
      description: msg`Heavy snow showers`,
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    95: {
      description: msg`Thunderstorm`,
      dayIcon: '/meteocons/thunderstorms-day.svg',
      nightIcon: '/meteocons/thunderstorms-night.svg',
    },
    96: {
      description: msg`Thunderstorm with slight hail`,
      dayIcon: '/meteocons/thunderstorms-day-rain.svg',
      nightIcon: '/meteocons/thunderstorms-night-rain.svg',
    },
    99: {
      description: msg`Thunderstorm with heavy hail`,
      dayIcon: '/meteocons/thunderstorms-day-rain.svg',
      nightIcon: '/meteocons/thunderstorms-night-rain.svg',
    },
  }

  const metadata = weatherMetadata[code]
  if (!metadata) {
    return {
      description: msg`Unknown (code ${code})`,
      icon: isDay ? '/meteocons/clear-day.svg' : '/meteocons/clear-night.svg',
    }
  }

  return {
    description: metadata.description,
    icon: isDay ? metadata.dayIcon : metadata.nightIcon || metadata.dayIcon,
  }
}

/**
 * Convert temperature between Celsius and Fahrenheit
 * @param temp - The temperature value
 * @param sourceUnit - The unit the temperature is currently in
 * @param targetUnit - The unit to convert to
 * @returns The converted temperature
 */
export const convertTemperature = (temp: number, sourceUnit: 'c' | 'f', targetUnit: 'c' | 'f'): number => {
  if (sourceUnit === targetUnit) {
    return Math.round(temp)
  }

  if (sourceUnit === 'c' && targetUnit === 'f') {
    return Math.round((temp * 9) / 5 + 32)
  }

  if (sourceUnit === 'f' && targetUnit === 'c') {
    return Math.round(((temp - 32) * 5) / 9)
  }

  return Math.round(temp)
}
