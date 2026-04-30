/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { createParser } from '@/lib/create-parser'
import { z } from 'zod'
import type { WeatherForecastData } from './lib'

/**
 * Zod schema for weather-forecast widget
 */
export const schema = z.object({
  widget: z.literal('weather-forecast'),
  args: z.object({
    location: z.string().min(1, 'Location is required'),
    region: z.string().min(1, 'Region is required'),
    country: z.string().min(1, 'Country is required'),
  }),
})

export type WeatherForecastWidget = z.infer<typeof schema>

/**
 * Type of data cached by this widget
 */
export type CacheData = WeatherForecastData

/**
 * Parse function - auto-generated from schema
 */
export const parse = createParser(schema)
