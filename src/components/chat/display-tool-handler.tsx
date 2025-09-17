import { splitPartType } from '@/lib/utils'
import { type ToolUIPart } from 'ai'
import { memo } from 'react'
import { WeatherForecast } from './weather-forecast'
import { type WeatherForecastData } from '@/lib/weather-forecast'

type DisplayToolHandlerProps = {
  part: ToolUIPart
}

export const DisplayToolHandler = memo(({ part }: DisplayToolHandlerProps) => {
  const { toolName } = splitPartType(part.type)

  switch (toolName) {
    case 'weather_forecast':
      return <WeatherForecast {...(part.output as WeatherForecastData)} />
    default:
      null
  }
})
