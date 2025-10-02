import { splitPartType } from '@/lib/utils'
import { type WeatherForecastData } from '@/lib/weather-forecast'
import { type ToolUIPart } from 'ai'
import { memo } from 'react'
import { ToolPart } from './tool-part'
import { WeatherForecast } from './weather-forecast'

type DisplayToolHandlerProps = {
  part: ToolUIPart
}

export const DisplayToolHandler = memo(({ part }: DisplayToolHandlerProps) => {
  const [, toolName] = splitPartType(part.type)

  switch (toolName) {
    case 'display-weather_forecast':
      return <WeatherForecast {...(part.output as WeatherForecastData)} />
    default:
      return <ToolPart part={part as ToolUIPart} />
  }
})
