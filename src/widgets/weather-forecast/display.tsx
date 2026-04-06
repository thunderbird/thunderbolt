import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Skeleton } from '@/components/ui/skeleton'
import dayjs from 'dayjs'
import { useState } from 'react'
import { convertTemperature, getWeatherMetadata, type WeatherForecastData } from './lib'

type WeatherForecastProps = WeatherForecastData

export const WeatherForecast = ({ days = [], temperature_unit }: WeatherForecastProps) => {
  const [temperatureUnit, setTemperatureUnit] = useState<'c' | 'f'>(temperature_unit)
  const today = days[0]
  const forecastDays = days.slice(1)

  if (!today) {
    return <WeatherForecastSkeleton />
  }

  const todayMeta = getWeatherMetadata(today.weather_code, today.date)
  const unit = temperatureUnit === 'c' ? 'C' : 'F'

  return (
    <div className="my-4 w-full">
      {/* Mobile: stacked, Desktop: single row */}
      <div className="flex flex-col gap-1.5 md:flex-row">
        {/* Today card */}
        <div className="flex items-center justify-between rounded-2xl border border-border px-4 md:w-auto md:min-w-[280px] md:gap-4">
          {/* Mobile: date left, icon center, temp right */}
          {/* Desktop: date+temp left, icon right */}
          <div className="flex flex-col py-3 md:gap-1">
            <p className="text-[length:var(--font-size-sm)] text-muted-foreground">
              {dayjs(today.date).format('dddd, MMM D')}
            </p>
            <div className="hidden items-start md:flex">
              <span className="text-[40px] font-medium leading-none tracking-tight">
                {convertTemperature(today.temperature_max, temperature_unit, temperatureUnit)}°
              </span>
              <span className="text-[20px] leading-none tracking-tight text-muted-foreground">{unit}</span>
            </div>
            <p className="hidden text-[length:var(--font-size-xs)] text-foreground md:block">{todayMeta.description}</p>
          </div>
          <img className="size-[72px] md:size-[92px]" src={todayMeta.icon} alt={todayMeta.description} />
          {/* Mobile only: temp + description on right */}
          <div className="flex flex-col items-end gap-1 md:hidden">
            <div className="flex items-start">
              <span className="text-[32px] font-medium leading-none tracking-tight">
                {convertTemperature(today.temperature_max, temperature_unit, temperatureUnit)}°
              </span>
              <span className="text-[16px] leading-none tracking-tight text-muted-foreground">{unit}</span>
            </div>
            <p className="text-[length:var(--font-size-xs)] text-right text-foreground">{todayMeta.description}</p>
          </div>
        </div>

        {/* Forecast days — horizontal row */}
        <div className="flex flex-1 gap-1.5">
          {forecastDays.map((day) => {
            const meta = getWeatherMetadata(day.weather_code, day.date)
            return (
              <div
                key={day.date}
                className="flex flex-1 flex-col items-center gap-0.5 rounded-lg bg-secondary/60 px-1.5 py-2 dark:bg-secondary/40"
              >
                <p className="text-[length:var(--font-size-xs)] font-medium text-muted-foreground">
                  {dayjs(day.date).format('ddd')}
                </p>
                <img className="size-10" src={meta.icon} alt={meta.description} />
                <p className="text-[18px] font-medium leading-none tracking-tight">
                  {convertTemperature(day.temperature_max, temperature_unit, temperatureUnit)}°
                </p>
              </div>
            )
          })}
        </div>
      </div>

      {/* Footer — unit toggle */}
      <div className="mt-2 flex items-center justify-end">
        <ToggleGroup
          type="single"
          value={temperatureUnit}
          onValueChange={(value) => value && setTemperatureUnit(value as 'c' | 'f')}
          aria-label="Temperature Unit"
          variant="outline"
          className="cursor-pointer"
        >
          <ToggleGroupItem
            value="c"
            aria-label="Celsius"
            className="cursor-pointer data-[state=on]:bg-secondary data-[state=on]:text-foreground"
          >
            °C
          </ToggleGroupItem>
          <ToggleGroupItem
            value="f"
            aria-label="Fahrenheit"
            className="cursor-pointer data-[state=on]:bg-secondary data-[state=on]:text-foreground"
          >
            °F
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </div>
  )
}

export const WeatherForecastSkeleton = () => (
  <div className="my-4 w-full">
    <div className="flex flex-col gap-1.5 md:flex-row">
      <Skeleton className="h-[88px] w-full rounded-2xl md:w-[280px]" />
      <div className="flex flex-1 gap-1.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[88px] flex-1 rounded-lg" />
        ))}
      </div>
    </div>
  </div>
)
