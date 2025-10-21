import { useMessageCache } from '@/hooks/use-message-cache'
import { getWeatherForecast } from '@/integrations/thunderbolt-pro/api'
import { type WeatherForecastData } from '@/lib/weather-forecast'
import { Skeleton } from '../ui/skeleton'
import { WeatherForecast } from './weather-forecast'

type WeatherForecastVisualProps = {
  location: string
  region: string
  country: string
  days: number
  messageId: string
}

/**
 * Wrapper component that fetches weather data and renders the WeatherForecast component
 */
export const WeatherForecastVisual = ({ location, region, country, days, messageId }: WeatherForecastVisualProps) => {
  const { data, isLoading, error } = useMessageCache<WeatherForecastData>({
    messageId,
    cacheKey: `weather.${location}.${region}.${country}.${days}`,
    fetchFn: async () => {
      return getWeatherForecast({ location, region, country, days })
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
    return (
      <div className="w-full space-y-4 my-4">
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    )
  }

  if (!data) {
    return null
  }

  return <WeatherForecast {...data} />
}
