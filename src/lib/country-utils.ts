/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Extracts country name from a location string
 * @param locationName - Location string in format "City, Region, Country"
 * @returns Country name or null if not found
 */
export const extractCountryFromLocation = (locationName: string): string | null => {
  if (!locationName) {
    return null
  }

  const parts = locationName.split(',').map((part) => part.trim())
  return parts.length > 0 ? parts[parts.length - 1] : null
}
