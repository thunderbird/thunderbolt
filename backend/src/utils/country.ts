/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import countryMappingData from '../data/localization/country-mapping.json'
import unitsByCountryData from '../data/localization/units-by-country.json'

/**
 * Resolves a country name or code to a 2-letter ISO country code
 * @param countryInput - Country name, 2-letter code, or 3-letter code
 * @returns 2-letter ISO country code or null if not found
 */
export const resolveCountryCode = (countryInput: string): string | null => {
  if (!countryInput || typeof countryInput !== 'string') {
    return null
  }

  const trimmedInput = countryInput.trim()

  if (trimmedInput.length === 2 && /^[A-Z]{2}$/.test(trimmedInput)) {
    const exists = Object.values(countryMappingData).includes(trimmedInput)
    if (exists) {
      return trimmedInput
    }

    if (unitsByCountryData[trimmedInput as keyof typeof unitsByCountryData]) {
      return trimmedInput
    }
  }

  if (trimmedInput.length === 3 && /^[A-Z]{3}$/.test(trimmedInput)) {
    return countryMappingData[trimmedInput as keyof typeof countryMappingData] || null
  }

  const variations = [
    trimmedInput,
    trimmedInput.charAt(0).toUpperCase() + trimmedInput.slice(1).toLowerCase(),
    trimmedInput.toLowerCase(),
    trimmedInput.toUpperCase(),
  ]

  if (trimmedInput.includes(' ')) {
    const titleCase = trimmedInput
      .toLowerCase()
      .split(' ')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
    variations.push(titleCase)
  }

  for (const variation of variations) {
    const result = countryMappingData[variation as keyof typeof countryMappingData]
    if (result) {
      return result
    }
  }

  return null
}
