import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { cn } from '@/lib/utils'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { convertTemperature, getWeatherMetadata, type WeatherForecastData } from './lib'

type WeatherForecastProps = WeatherForecastData

export const WeatherForecast = ({ location, days = [], temperature_unit }: WeatherForecastProps) => {
  const [temperatureUnit, setTemperatureUnit] = useState<'c' | 'f'>(temperature_unit)

  const [selectedDayIndex, setSelectedDayIndex] = useState(0)

  // Sync local state with prop when it changes
  useEffect(() => {
    setTemperatureUnit(temperature_unit)
  }, [temperature_unit])

  const selectedDayMetadata = useMemo(
    () =>
      days[selectedDayIndex]
        ? getWeatherMetadata(days[selectedDayIndex].weather_code, days[selectedDayIndex].date)
        : null,
    [days, selectedDayIndex],
  )

  if (!selectedDayMetadata) {
    return <WeatherForecastSkeleton />
  }

  return (
    <Card className="w-full pb-0 overflow-hidden my-4">
      <CardHeader className="flex-col md:flex-row flex justify-between items-start gap-6">
        <div>
          <p className="text-2xl font-bold">{selectedDayMetadata.description}</p>
          <p className="text-sm font-normal">{location}</p>
        </div>
        <ToggleGroup
          type="single"
          value={temperatureUnit}
          onValueChange={(value) => value && setTemperatureUnit(value as 'c' | 'f')}
          aria-label="Temperature Unit"
          variant="outline"
          className="cursor-pointer"
        >
          <ToggleGroupItem value="c" aria-label="Celsius" className="cursor-pointer">
            °C
          </ToggleGroupItem>
          <ToggleGroupItem value="f" aria-label="Fahrenheit" className="cursor-pointer">
            °F
          </ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-7 border-t border-t-border px-0">
        {days.map((day, dayIndex) => {
          const dayMetadata = getWeatherMetadata(day.weather_code, day.date)

          return (
            <a
              className={cn(
                'items-center flex flex-row md:flex-col justify-between px-6 md:px-0 md:justify-center gap-1 py-6 cursor-pointer',
                dayIndex > 0 ? 'border-t border-t-border border-l-0 md:border-t-0 md:border-l md:border-l-border' : '',
                dayIndex === selectedDayIndex ? 'bg-secondary/60 dark:bg-secondary/40' : '',
              )}
              key={day.date}
              onClick={() => setSelectedDayIndex(dayIndex)}
            >
              <p className="text-sm font-bold">{dayjs(day.date).format('ddd')}</p>
              <img className="size-10" src={dayMetadata.icon} alt={dayMetadata.description} />
              <div className="flex flex-row gap-1 items-center justify-center min-w-[4rem]">
                <p className="text-base font-bold tabular-nums">
                  {convertTemperature(day.temperature_max, temperature_unit, temperatureUnit)}°
                </p>
                <p className="text-sm font-normal tabular-nums">
                  {convertTemperature(day.temperature_min, temperature_unit, temperatureUnit)}°
                </p>
              </div>
            </a>
          )
        })}
      </CardContent>
    </Card>
  )
}

const WeatherForecastSkeleton = () => {
  return (
    <Card className="w-full pb-0 overflow-hidden">
      <CardHeader className="flex-col md:flex-row flex justify-between items-start gap-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex gap-1">
          <Skeleton className="h-9 w-12" />
          <Skeleton className="h-9 w-12" />
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-7 border-t border-t-border px-0">
        {Array.from({ length: 7 }).map((_, dayIndex) => (
          <div
            key={dayIndex}
            className={cn(
              'items-center flex flex-row md:flex-col justify-between px-6 md:px-0 md:justify-center gap-1 py-6',
              dayIndex > 0 ? 'border-t border-t-border border-l-0 md:border-t-0 md:border-l md:border-l-border' : '',
            )}
          >
            <Skeleton className="h-4 w-8" />
            <Skeleton className="size-10 rounded-full" />
            <div className="flex flex-row gap-1 items-center justify-center min-w-[4rem]">
              <Skeleton className="h-5 w-8" />
              <Skeleton className="h-4 w-6" />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
