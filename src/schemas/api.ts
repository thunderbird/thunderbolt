/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { z } from 'zod'

export const currencySchema = z.object({
  code: z.string(),
  symbol: z.string(),
  name: z.string(),
})

export const dateFormatSchema = z.object({
  format: z.string(),
  example: z.string(),
})

export const temperatureUnitSchema = z.object({
  symbol: z.string(),
  name: z.string(),
})

// API Response Schemas
export const unitsOptionsResponseSchema = z.object({
  units: z.array(z.string()),
  temperature: z.array(temperatureUnitSchema),
  timeFormat: z.array(z.string()),
  dateFormats: z.array(dateFormatSchema),
  currencies: z.array(currencySchema),
})

export const countryUnitsResponseSchema = z.object({
  unit: z.string(),
  temperature: z.string(),
  timeFormat: z.string(),
  dateFormatExample: z.string(),
  currency: currencySchema,
})

export type Currency = z.infer<typeof currencySchema>
export type DateFormat = z.infer<typeof dateFormatSchema>
export type TemperatureUnit = z.infer<typeof temperatureUnitSchema>
export type UnitsOptionsData = z.infer<typeof unitsOptionsResponseSchema>
export type CountryUnitsData = z.infer<typeof countryUnitsResponseSchema>
