import { Card, CardContent, CardHeader } from '../ui/card'
import { useMemo, useState } from 'react'
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group'
import { cn } from '@/lib/utils'
import dayjs from 'dayjs'
import { convertTemperature, getWeatherMetadata, type WeatherForecastData } from '@/lib/weather-forecast'

type WeatherForecastProps = WeatherForecastData

export const WeatherForecast = ({ location, days = [] }: WeatherForecastProps) => {
  const [temperatureUnit, setTemperatureUnit] = useState<'c' | 'f'>('c')

  const [selectedDayIndex, setSelectedDayIndex] = useState(0)

  const selectedDayMetadata = useMemo(
    () =>
      days[selectedDayIndex]
        ? getWeatherMetadata(days[selectedDayIndex].weather_code, days[selectedDayIndex].date)
        : null,
    [days, selectedDayIndex],
  )

  if (!selectedDayMetadata) {
    return null
  }

  return (
    <Card className="w-full pb-0 overflow-hidden">
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
        >
          <ToggleGroupItem value="c" aria-label="Celsius">
            °C
          </ToggleGroupItem>
          <ToggleGroupItem value="f" aria-label="Fahrenheit">
            °F
          </ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>
      <CardContent className="grid grid-flow-row md:grid-flow-col border-t border-t-border px-0">
        {days.map((day, dayIndex) => {
          const dayMetadata = getWeatherMetadata(day.weather_code, day.date)

          return (
            <a
              className={cn(
                'items-center flex flex-row md:flex-col justify-between px-6 md:px-0 md:justify-center gap-1 py-6 cursor-pointer',
                dayIndex > 0 ? 'border-t border-t-border border-l-0 md:border-t-0 md:border-l md:border-l-border' : '',
                dayIndex === selectedDayIndex ? 'bg-accent' : '',
              )}
              key={day.date}
              onClick={() => setSelectedDayIndex(dayIndex)}
            >
              <p className="text-sm font-bold">{dayjs(day.date).format('ddd')}</p>
              <img className="size-10" src={dayMetadata.icon} alt={dayMetadata.description} />
              <div className="flex flex-row gap-1 items-center justify-center">
                <p className="text-base font-bold">{convertTemperature(day.temperature_max, temperatureUnit)}°</p>
                <p className="text-sm font-normal">{convertTemperature(day.temperature_min, temperatureUnit)}°</p>
              </div>
            </a>
          )
        })}
      </CardContent>
    </Card>
  )
}
