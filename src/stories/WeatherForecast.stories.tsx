import { WeatherForecast } from '@/components/chat/weather-forecast'
import { type WeatherForecastData } from '@/lib/weather-forecast'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'

// Wrapper component to handle day/night toggle
const WeatherForecastWithToggle = ({
  location,
  days,
  isDayTime = true,
}: WeatherForecastData & { isDayTime?: boolean }) => {
  const [dayTime, setDayTime] = useState(isDayTime)

  // Modify the days data to reflect the time of day
  const modifiedDays = days.map((day) => ({
    ...day,
    date: dayTime
      ? day.date + 'T12:00:00' // Day time
      : day.date + 'T22:00:00', // Night time
  }))

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">Time of Day:</label>
        <button
          onClick={() => setDayTime(!dayTime)}
          className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
            dayTime ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          {dayTime ? '☀️ Day' : '🌙 Night'}
        </button>
      </div>
      <WeatherForecast location={location} days={modifiedDays} />
    </div>
  )
}

const meta = {
  title: 'components/chat/weather-forecast',
  component: WeatherForecastWithToggle,
  parameters: {
    layout: 'centered',
    docs: {
      story: {
        inline: false,
        iframeHeight: 500,
      },
    },
    viewport: {
      defaultViewport: 'responsive',
    },
  },
  decorators: [
    (Story) => (
      <div style={{ minWidth: '600px', width: '100%', maxWidth: '800px' }}>
        <Story />
      </div>
    ),
  ],
  tags: ['autodocs'],
  argTypes: {
    location: {
      description: 'Weather forecast location',
      control: { type: 'text' },
    },
    days: {
      description: 'Weather forecast days object',
      control: { type: 'object' },
    },
    isDayTime: {
      description: 'Initial time of day setting',
      control: { type: 'boolean' },
      defaultValue: true,
    },
  },
} satisfies Meta<typeof WeatherForecastWithToggle>

export default meta
type Story = StoryObj<typeof meta>

// Helper function to create weather data with specific codes and time
const createWeatherData = (codes: number[], isDayTime: boolean = true): WeatherForecastData => {
  const baseDate = isDayTime ? '2024-12-16T12:00:00' : '2024-12-16T22:00:00'

  return {
    location: 'San Francisco, CA, United States',
    days: codes.map((code, index) => ({
      date: new Date(new Date(baseDate).getTime() + index * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      weather_code: code,
      temperature_max: 18 + Math.random() * 10,
      temperature_min: 8 + Math.random() * 8,
    })),
  }
}

// Basic stories
export const Default: Story = {
  args: {
    ...createWeatherData([0, 1, 2, 3, 61]),
  },
}

export const ClearSky: Story = {
  args: {
    ...createWeatherData([0]),
  },
  parameters: {
    docs: {
      description: {
        story: 'Clear sky weather condition',
      },
    },
  },
}

export const PartlyCloudy: Story = {
  args: {
    ...createWeatherData([2]),
  },
  parameters: {
    docs: {
      description: {
        story: 'Partly cloudy weather condition',
      },
    },
  },
}

export const Rain: Story = {
  args: {
    ...createWeatherData([63]),
  },
  parameters: {
    docs: {
      description: {
        story: 'Moderate rain weather condition',
      },
    },
  },
}

export const Snow: Story = {
  args: {
    ...createWeatherData([73]),
  },
  parameters: {
    docs: {
      description: {
        story: 'Moderate snow fall weather condition',
      },
    },
  },
}

export const Thunderstorm: Story = {
  args: {
    ...createWeatherData([95]),
  },
  parameters: {
    docs: {
      description: {
        story: 'Thunderstorm weather condition',
      },
    },
  },
}

// Night variations
export const ClearSkyNight: Story = {
  args: {
    ...createWeatherData([0], false),
  },
  parameters: {
    docs: {
      description: {
        story: 'Clear sky weather condition at night',
      },
    },
  },
}

export const RainNight: Story = {
  args: {
    ...createWeatherData([63], false),
  },
  parameters: {
    docs: {
      description: {
        story: 'Moderate rain weather condition at night',
      },
    },
  },
}

// Interactive examples
export const InteractiveDayNightToggle: Story = {
  args: {
    location: 'Interactive Weather Demo',
    days: [
      { date: '2024-12-16', weather_code: 0, temperature_max: 22, temperature_min: 12 },
      { date: '2024-12-17', weather_code: 2, temperature_max: 20, temperature_min: 14 },
      { date: '2024-12-18', weather_code: 63, temperature_max: 18, temperature_min: 10 },
      { date: '2024-12-19', weather_code: 73, temperature_max: 16, temperature_min: 8 },
      { date: '2024-12-20', weather_code: 95, temperature_max: 14, temperature_min: 6 },
    ],
    isDayTime: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Interactive example with day/night toggle button. Click the toggle to see how weather icons change between day and night variations.',
      },
    },
    decorators: [
      (Story: any) => (
        <div style={{ minWidth: '650px', width: '100%', maxWidth: '850px' }}>
          <Story />
        </div>
      ),
    ],
  },
}

export const NightModeDefault: Story = {
  args: {
    location: 'Night Weather Demo',
    days: [
      { date: '2024-12-16', weather_code: 0, temperature_max: 22, temperature_min: 12 },
      { date: '2024-12-17', weather_code: 2, temperature_max: 20, temperature_min: 14 },
      { date: '2024-12-18', weather_code: 63, temperature_max: 18, temperature_min: 10 },
    ],
    isDayTime: false,
  },
  parameters: {
    docs: {
      description: {
        story: 'Weather forecast starting in night mode, showing night variations of weather icons',
      },
    },
  },
}

// All weather codes showcase
export const AllWeatherCodes: Story = {
  args: {
    location: 'Weather Showcase',
    days: [
      { date: '2024-12-16', weather_code: 0, temperature_max: 22, temperature_min: 12 },
      { date: '2024-12-17', weather_code: 1, temperature_max: 20, temperature_min: 14 },
      { date: '2024-12-18', weather_code: 2, temperature_max: 18, temperature_min: 10 },
      { date: '2024-12-19', weather_code: 3, temperature_max: 16, temperature_min: 8 },
      { date: '2024-12-20', weather_code: 45, temperature_max: 14, temperature_min: 6 },
      { date: '2024-12-21', weather_code: 48, temperature_max: 12, temperature_min: 4 },
      { date: '2024-12-22', weather_code: 51, temperature_max: 15, temperature_min: 7 },
    ],
  },
  parameters: {
    docs: {
      description: {
        story: 'Showcase of various weather codes in a single forecast with day/night toggle',
      },
    },
    decorators: [
      (Story: any) => (
        <div style={{ minWidth: '700px', width: '100%', maxWidth: '900px' }}>
          <Story />
        </div>
      ),
    ],
  },
}
