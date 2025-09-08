"""
FastAPI routes for Thunderbolt Pro Tools
"""

from fastapi import FastAPI

from .context import SimpleContext
from .exa import create_exa_client, fetch_content_exa, search_exa
from .models import (
    FetchContentRequest,
    FetchContentResponse,
    LocationSearchRequest,
    LocationSearchResponse,
    SearchRequest,
    SearchResponse,
    WeatherRequest,
    WeatherResponse,
)
from .openmeteo import OpenMeteoWeather

# Initialize the tool clients
exa_client = create_exa_client()
weather_client = OpenMeteoWeather()


def create_pro_tools_app() -> FastAPI:
    """Create FastAPI app with pro tools endpoints"""
    app = FastAPI(title="Thunderbolt Pro Tools", version="1.0.0")

    @app.post("/search", response_model=SearchResponse)
    async def search_exa_endpoint(request: SearchRequest) -> SearchResponse:
        """Search and return formatted results with neural search capabilities."""
        if not exa_client:
            return SearchResponse(
                results="",
                success=False,
                error="Search service is not configured. Please set the EXA_API_KEY environment variable.",
            )

        try:
            ctx = SimpleContext()
            results = await search_exa(request.query, ctx, request.max_results)

            # Format results for LLM - Exa SDK already provides LLM-optimized format
            if not results:
                formatted = "No results found."
            else:
                formatted_results = []
                for r in results:
                    formatted_results.append(f"{r['position']}. {r['title']}")
                    formatted_results.append(f"   URL: {r['url']}")
                    if r.get("snippet"):
                        formatted_results.append(f"   {r['snippet']}")
                formatted = "\n".join(formatted_results)

            return SearchResponse(results=formatted, success=True)
        except Exception as e:
            return SearchResponse(results="", success=False, error=str(e))

    @app.post("/fetch-content", response_model=FetchContentResponse)
    async def fetch_content_endpoint(
        request: FetchContentRequest,
    ) -> FetchContentResponse:
        """Fetch and parse content from a webpage URL using Exa's privacy-protected proxy.

        Returns whatever Exa returns to the user. If Exa is not configured,
        returns an error indicating the service is unavailable.
        """
        ctx = SimpleContext()

        # Require Exa to be configured
        if not exa_client:
            return FetchContentResponse(
                content="",
                success=False,
                error="Content fetching service is not configured. Please set the EXA_API_KEY environment variable.",
            )

        # Use Exa for privacy-protected fetching
        content = await fetch_content_exa(request.url, ctx)

        # Check if Exa returned an error message
        if content.startswith("Error:"):
            return FetchContentResponse(content="", success=False, error=content)

        return FetchContentResponse(content=content, success=True)

    @app.post("/weather/current", response_model=WeatherResponse)
    async def current_weather_endpoint(request: WeatherRequest) -> WeatherResponse:
        """Get current weather for specified location"""
        try:
            ctx = SimpleContext()
            weather_data = await weather_client.get_current_weather(
                request.location, ctx
            )

            return WeatherResponse(weather_data=weather_data, success=True)
        except Exception as e:
            return WeatherResponse(weather_data="", success=False, error=str(e))

    @app.post("/weather/forecast", response_model=WeatherResponse)
    async def weather_forecast_endpoint(request: WeatherRequest) -> WeatherResponse:
        """Get weather forecast for specified location"""
        try:
            ctx = SimpleContext()
            weather_data = await weather_client.get_weather_forecast(
                request.location, request.days, ctx
            )

            return WeatherResponse(weather_data=weather_data, success=True)
        except Exception as e:
            return WeatherResponse(weather_data="", success=False, error=str(e))

    @app.post("/locations/search", response_model=LocationSearchResponse)
    async def search_locations_endpoint(
        request: LocationSearchRequest,
    ) -> LocationSearchResponse:
        """Search for locations by name"""
        try:
            ctx = SimpleContext()
            locations = await weather_client.search_locations(request.query, ctx)

            if not locations:
                locations_str = f"No locations found matching: {request.query}"
            else:
                # Format the results as a string (same as MCP tool)
                result = []
                result.append(
                    f"Found {len(locations)} locations matching '{request.query}':"
                )
                result.append("")

                for i, location in enumerate(locations, 1):
                    # Build location string
                    location_parts = [location["name"]]
                    if location.get("admin1"):
                        location_parts.append(location["admin1"])
                    if location.get("country"):
                        location_parts.append(location["country"])

                    location_str = ", ".join(location_parts)

                    result.append(f"{i}. {location_str}")
                    result.append(
                        f"   Coordinates: {location['latitude']}, {location['longitude']}"
                    )
                    if location.get("elevation") is not None:
                        result.append(f"   Elevation: {location['elevation']}m")
                    result.append("")

                locations_str = "\n".join(result).strip()

            return LocationSearchResponse(locations=locations_str, success=True)
        except Exception as e:
            return LocationSearchResponse(locations="", success=False, error=str(e))

    return app
