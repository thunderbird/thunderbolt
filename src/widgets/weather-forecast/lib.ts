/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import dayjs from 'dayjs'
import { z } from 'zod'

const WeatherDaySchema = z.object({
  date: z.string(),
  weather_code: z.number(),
  temperature_max: z.number(),
  temperature_min: z.number(),
  apparent_temperature_max: z.number(),
  apparent_temperature_min: z.number(),
  precipitation_sum: z.number(),
  precipitation_probability_max: z.number(),
  wind_speed_10m_max: z.number(),
})

export const WeatherForecastDataSchema = z.object({
  location: z.string(),
  days: z.array(WeatherDaySchema).min(1).max(7),
  temperature_unit: z.enum(['c', 'f']),
})

export type WeatherDay = z.infer<typeof WeatherDaySchema>
export type WeatherForecastData = z.infer<typeof WeatherForecastDataSchema>

export type WeatherMetadata = {
  description: string
  icon: string
}

const isDayTime = (dateString: string): boolean => {
  try {
    const date = dayjs(dateString)
    const hour = dateString.includes('T') ? date.hour() : 12
    return hour >= 6 && hour < 18
  } catch {
    return true
  }
}

export const getWeatherMetadata = (code: number, dateString: string): WeatherMetadata => {
  const isDay = isDayTime(dateString)

  const weatherMetadata: Record<number, { description: string; dayIcon: string; nightIcon: string }> = {
    0: {
      description: 'Clear sky',
      dayIcon: '/meteocons/clear-day.svg',
      nightIcon: '/meteocons/clear-night.svg',
    },
    1: {
      description: 'Mainly clear',
      dayIcon: '/meteocons/partly-cloudy-day.svg',
      nightIcon: '/meteocons/partly-cloudy-night.svg',
    },
    2: {
      description: 'Partly cloudy',
      dayIcon: '/meteocons/partly-cloudy-day.svg',
      nightIcon: '/meteocons/partly-cloudy-night.svg',
    },
    3: {
      description: 'Overcast',
      dayIcon: '/meteocons/overcast-day.svg',
      nightIcon: '/meteocons/overcast-night.svg',
    },
    45: {
      description: 'Foggy',
      dayIcon: '/meteocons/fog-day.svg',
      nightIcon: '/meteocons/fog-night.svg',
    },
    48: {
      description: 'Depositing rime fog',
      dayIcon: '/meteocons/fog-day.svg',
      nightIcon: '/meteocons/fog-night.svg',
    },
    51: {
      description: 'Light drizzle',
      dayIcon: '/meteocons/partly-cloudy-day-drizzle.svg',
      nightIcon: '/meteocons/partly-cloudy-night-drizzle.svg',
    },
    53: {
      description: 'Moderate drizzle',
      dayIcon: '/meteocons/partly-cloudy-day-drizzle.svg',
      nightIcon: '/meteocons/partly-cloudy-night-drizzle.svg',
    },
    55: {
      description: 'Dense drizzle',
      dayIcon: '/meteocons/partly-cloudy-day-drizzle.svg',
      nightIcon: '/meteocons/partly-cloudy-night-drizzle.svg',
    },
    56: {
      description: 'Light freezing drizzle',
      dayIcon: '/meteocons/partly-cloudy-day-sleet.svg',
      nightIcon: '/meteocons/partly-cloudy-night-sleet.svg',
    },
    57: {
      description: 'Dense freezing drizzle',
      dayIcon: '/meteocons/partly-cloudy-day-sleet.svg',
      nightIcon: '/meteocons/partly-cloudy-night-sleet.svg',
    },
    61: {
      description: 'Slight rain',
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    63: {
      description: 'Moderate rain',
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    65: {
      description: 'Heavy rain',
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    66: {
      description: 'Light freezing rain',
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    67: {
      description: 'Heavy freezing rain',
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    71: {
      description: 'Slight snow fall',
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    73: {
      description: 'Moderate snow fall',
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    75: {
      description: 'Heavy snow fall',
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    77: {
      description: 'Snow grains',
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    80: {
      description: 'Slight rain showers',
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    81: {
      description: 'Moderate rain showers',
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    82: {
      description: 'Violent rain showers',
      dayIcon: '/meteocons/partly-cloudy-day-rain.svg',
      nightIcon: '/meteocons/partly-cloudy-night-rain.svg',
    },
    85: {
      description: 'Slight snow showers',
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    86: {
      description: 'Heavy snow showers',
      dayIcon: '/meteocons/partly-cloudy-day-snow.svg',
      nightIcon: '/meteocons/partly-cloudy-night-snow.svg',
    },
    95: {
      description: 'Thunderstorm',
      dayIcon: '/meteocons/thunderstorms-day.svg',
      nightIcon: '/meteocons/thunderstorms-night.svg',
    },
    96: {
      description: 'Thunderstorm with slight hail',
      dayIcon: '/meteocons/thunderstorms-day-rain.svg',
      nightIcon: '/meteocons/thunderstorms-night-rain.svg',
    },
    99: {
      description: 'Thunderstorm with heavy hail',
      dayIcon: '/meteocons/thunderstorms-day-rain.svg',
      nightIcon: '/meteocons/thunderstorms-night-rain.svg',
    },
  }

  const metadata = weatherMetadata[code]
  if (!metadata) {
    return {
      description: `Unknown (code ${code})`,
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
