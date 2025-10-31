/**
 * Extracts country name from a location string
 * @param locationName - Location string in format "City, Region, Country"
 * @returns Country name or null if not found
 */
export const extractCountryFromLocation = (locationName: string): string | null => {
  if (!locationName) return null

  const parts = locationName.split(',').map((part) => part.trim())
  return parts.length > 0 ? parts[parts.length - 1] : null
}
