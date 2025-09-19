"""
OpenMeteo weather API functionality
"""

import sys
import traceback
from datetime import datetime
from typing import Any

import httpx

from .context import SimpleContext
from .models import WeatherDay, WeatherForecastData


class OpenMeteoWeather:
    """Client for interacting with Open-Meteo weather API."""

    BASE_URL = "https://api.open-meteo.com/v1"
    GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1"

    async def search_locations(
        self, query: str, ctx: SimpleContext, count: int = 10
    ) -> list[dict[str, Any]]:
        """Search for locations using Open-Meteo geocoding API."""
        await ctx.info(f"Searching for locations matching: {query}")

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.GEOCODING_URL}/search",
                    params={
                        "name": query,
                        "count": count,
                        "language": "en",
                        "format": "json",
                    },
                    timeout=30.0,
                )
                response.raise_for_status()
                data = response.json()

                locations = data.get("results", [])
                await ctx.info(f"Found {len(locations)} locations matching '{query}'")
                return locations

        except httpx.HTTPError as e:
            await ctx.error(f"HTTP error searching locations: {str(e)}")
            return []
        except Exception as e:
            await ctx.error(f"Error searching locations: {str(e)}")
            traceback.print_exc(file=sys.stderr)
            return []

    async def get_current_weather(self, location: str, ctx: SimpleContext) -> str:
        """Get current weather for specified location."""
        await ctx.info(f"Fetching current weather for location: {location}")

        # First, get coordinates for the location
        locations = await self.search_locations(location, ctx, count=1)
        if not locations:
            return f"Error: Could not find coordinates for location '{location}'"

        # Use the first (best) match
        best_location = locations[0]
        lat = best_location["latitude"]
        lng = best_location["longitude"]
        location_name = best_location["name"]

        # Add admin1 and country if available for better location description
        location_parts = [location_name]
        if best_location.get("admin1"):
            location_parts.append(best_location["admin1"])
        if best_location.get("country"):
            location_parts.append(best_location["country"])
        full_location_name = ", ".join(location_parts)

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.BASE_URL}/forecast",
                    params={
                        "latitude": lat,
                        "longitude": lng,
                        "current": "temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
                        "timezone": "auto",
                    },
                    timeout=30.0,
                )
                response.raise_for_status()
                data = response.json()

            current = data.get("current", {})

            result = []
            result.append(f"Current weather for {full_location_name}:")
            result.append("")
            result.append(
                f"Temperature: {current.get('temperature_2m')}°C (feels like {current.get('apparent_temperature')}°C)"
            )
            result.append(f"Humidity: {current.get('relative_humidity_2m')}%")
            result.append(f"Cloud cover: {current.get('cloud_cover')}%")
            result.append(f"Precipitation: {current.get('precipitation')} mm")
            result.append(f"Pressure: {current.get('pressure_msl')} hPa")
            result.append(f"Wind: {current.get('wind_speed_10m')} km/h")

            weather_code = current.get("weather_code", 0)
            result.append(
                f"Conditions: {self._get_weather_description(weather_code)} (Code {weather_code})"
            )

            return "\n".join(result)

        except httpx.HTTPError as e:
            await ctx.error(f"HTTP error getting current weather: {str(e)}")
            return f"Error: Could not fetch current weather data ({str(e)})"
        except Exception as e:
            await ctx.error(f"Error getting current weather: {str(e)}")
            traceback.print_exc(file=sys.stderr)
            return f"Error: An unexpected error occurred while fetching current weather data ({str(e)})"

    async def get_weather_forecast(
        self, location: str, days: int, ctx: SimpleContext
    ) -> WeatherForecastData:
        """Get weather forecast for specified location."""
        await ctx.info(f"Fetching {days}-day forecast for location: {location}")

        # First, get coordinates for the location
        locations = await self.search_locations(location, ctx, count=1)
        if not locations:
            await ctx.error(f"Could not find coordinates for location '{location}'")
            return WeatherForecastData(location=location, days=[])

        # Use the first (best) match
        best_location = locations[0]
        lat = best_location["latitude"]
        lng = best_location["longitude"]
        location_name = best_location["name"]

        # Add admin1 and country if available for better location description
        location_parts = [location_name]
        if best_location.get("admin1"):
            location_parts.append(best_location["admin1"])
        if best_location.get("country"):
            location_parts.append(best_location["country"])
        full_location_name = ", ".join(location_parts)

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    f"{self.BASE_URL}/forecast",
                    params={
                        "latitude": lat,
                        "longitude": lng,
                        "daily": "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max",
                        "timezone": "auto",
                        "forecast_days": days,
                    },
                    timeout=30.0,
                )
                response.raise_for_status()
                data = response.json()

            daily = data.get("daily", {})
            dates = daily.get("time", [])

            weather_days = []
            for i in range(min(len(dates), days)):
                date = dates[i]
                weather_code = (
                    daily["weather_code"][i]
                    if i < len(daily.get("weather_code", []))
                    else 0
                )

                weather_day = WeatherDay(
                    date=date,
                    weather_code=weather_code,
                    temperature_max=daily["temperature_2m_max"][i],
                    temperature_min=daily["temperature_2m_min"][i],
                    apparent_temperature_max=daily["apparent_temperature_max"][i],
                    apparent_temperature_min=daily["apparent_temperature_min"][i],
                    precipitation_sum=daily["precipitation_sum"][i],
                    precipitation_probability_max=daily[
                        "precipitation_probability_max"
                    ][i],
                    wind_speed_10m_max=daily["wind_speed_10m_max"][i],
                )
                weather_days.append(weather_day)

            return WeatherForecastData(location=full_location_name, days=weather_days)

        except httpx.HTTPError as e:
            await ctx.error(f"HTTP error getting forecast: {str(e)}")
            return WeatherForecastData(location=full_location_name, days=[])
        except Exception as e:
            await ctx.error(f"Error getting forecast: {str(e)}")
            traceback.print_exc(file=sys.stderr)
            return WeatherForecastData(location=full_location_name, days=[])

    def _get_weather_description(self, code: int) -> str:
        """Convert WMO weather code to description."""
        weather_codes = {
            0: "Clear sky",
            1: "Mainly clear",
            2: "Partly cloudy",
            3: "Overcast",
            45: "Foggy",
            48: "Depositing rime fog",
            51: "Light drizzle",
            53: "Moderate drizzle",
            55: "Dense drizzle",
            56: "Light freezing drizzle",
            57: "Dense freezing drizzle",
            61: "Slight rain",
            63: "Moderate rain",
            65: "Heavy rain",
            66: "Light freezing rain",
            67: "Heavy freezing rain",
            71: "Slight snow fall",
            73: "Moderate snow fall",
            75: "Heavy snow fall",
            77: "Snow grains",
            80: "Slight rain showers",
            81: "Moderate rain showers",
            82: "Violent rain showers",
            85: "Slight snow showers",
            86: "Heavy snow showers",
            95: "Thunderstorm",
            96: "Thunderstorm with slight hail",
            99: "Thunderstorm with heavy hail",
        }
        return weather_codes.get(code, f"Unknown (code {code})")

    def _format_date(self, date_str: str) -> str:
        """Format date string to be more readable."""
        try:
            date = datetime.fromisoformat(date_str)
            return date.strftime("%A, %B %d")
        except:
            return date_str
