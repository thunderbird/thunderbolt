/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Trans } from '@lingui/react/macro'
import { useMessageCache } from '@/hooks/use-message-cache'
import { useSettings } from '@/hooks/use-settings'
import { WeatherForecast, WeatherForecastSkeleton } from './display'
import { fetchWeatherForecast } from './fetch-forecast'
import type { WeatherForecastData } from './lib'

type WeatherForecastWidgetProps = {
  location: string
  region: string
  country: string
  messageId: string
}

/**
 * Wrapper component that fetches weather data and renders the WeatherForecast component
 * Fetches 6 days of weather data (today + 5 forecast days)
 */
export const WeatherForecastWidget = ({ location, region, country, messageId }: WeatherForecastWidgetProps) => {
  // Celsius, not Fahrenheit, for the window before `useUnitDefaults` seeds the
  // setting: CLDR puts six regions on Fahrenheit and the other 249 on Celsius.
  const { temperatureUnit } = useSettings({ temperature_unit: 'c' })
  const { data, error } = useMessageCache<WeatherForecastData>({
    messageId,
    cacheKey: ['weatherForecast', location, region, country, temperatureUnit.value],
    enabled: !temperatureUnit.isLoading,
    fetchFn: async () =>
      fetchWeatherForecast({
        location,
        region,
        country,
        days: 6,
        temperatureUnit: temperatureUnit.value === 'f' ? 'f' : 'c',
      }),
  })

  if (error) {
    // Two whole messages rather than one with a maybe-translated tail: the
    // placeholder used to hold `t`Unknown error`` on the else branch, so the
    // translator could not tell the value was itself copy.
    const errorMessage = error instanceof Error ? error.message : null
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 my-4 dark:border-red-800 dark:bg-red-950">
        <p className="text-sm text-red-800 dark:text-red-200">
          {errorMessage ? (
            <Trans>Unable to load weather forecast: {errorMessage}</Trans>
          ) : (
            <Trans>Unable to load weather forecast.</Trans>
          )}
        </p>
      </div>
    )
  }

  // No data while the settings gate is closed or the fetch is in flight — the skeleton covers both.
  if (!data) {
    return <WeatherForecastSkeleton />
  }

  return <WeatherForecast {...data} />
}
