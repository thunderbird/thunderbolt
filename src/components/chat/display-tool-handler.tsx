import { splitPartType } from '@/lib/utils'
import { type ToolUIPart } from 'ai'
import { memo } from 'react'
import { WeatherForecast } from './weather-forecast'
import { type WeatherForecastData } from '@/lib/weather-forecast'
import { ToolPart } from './tool-part'

type DisplayToolHandlerProps = {
  part: ToolUIPart
}

export const DisplayToolHandler = memo(({ part }: DisplayToolHandlerProps) => {
  const { toolName } = splitPartType(part.type)

  switch (toolName) {
    case 'get_weather_forecast':
      return <WeatherForecast {...(part.output as WeatherForecastData)} />
    default:
      return <ToolPart part={part as ToolUIPart} />
  }
})
