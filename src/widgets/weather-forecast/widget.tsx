import { useHttpClient } from '@/contexts'
import { useMessageCache } from '@/hooks/use-message-cache'
import { getWeatherForecast } from '@/integrations/thunderbolt-pro/api'
import { WeatherForecast, WeatherForecastSkeleton } from './display'
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
  const httpClient = useHttpClient()
  const { data, isLoading, error } = useMessageCache<WeatherForecastData>({
    messageId,
    cacheKey: ['weatherForecast', location, region, country],
    fetchFn: async () => {
      return getWeatherForecast({ location, region, country, days: 6 }, httpClient)
    },
  })

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 my-4 dark:border-red-800 dark:bg-red-950">
        <p className="text-sm text-red-800 dark:text-red-200">
          Unable to load weather forecast: {error instanceof Error ? error.message : 'Unknown error'}
        </p>
      </div>
    )
  }

  if (isLoading) {
    return <WeatherForecastSkeleton />
  }

  if (!data) {
    return null
  }

  return <WeatherForecast {...data} />
}
