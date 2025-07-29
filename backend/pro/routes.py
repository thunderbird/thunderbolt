"""
FastAPI routes for Thunderbolt Pro Tools
"""

from fastapi import FastAPI

from .context import SimpleContext
from .duckduckgo import DuckDuckGoSearcher
from .exa import ExaSearcher
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
from .web_content_fetcher import WebContentFetcher

# Initialize the tool clients
ddg_searcher = DuckDuckGoSearcher()
try:
    exa_searcher = ExaSearcher()
except ValueError:
    # Exa API key not configured
    exa_searcher = None
fetcher = WebContentFetcher()
weather_client = OpenMeteoWeather()


def create_pro_tools_app() -> FastAPI:
    """Create FastAPI app with pro tools endpoints"""
    app = FastAPI(title="Thunderbolt Pro Tools", version="1.0.0")

    @app.post("/search-duckduckgo", response_model=SearchResponse)
    async def search_endpoint(request: SearchRequest) -> SearchResponse:
        """Search DuckDuckGo and return formatted results. This only returns links, not content. You should use the fetch-content endpoint to get the content of the links."""
        try:
            ctx = SimpleContext()
            results = await ddg_searcher.search(request.query, ctx, request.max_results)
            formatted = ddg_searcher.format_results_for_llm(results)

            return SearchResponse(results=formatted, success=True)
        except Exception as e:
            return SearchResponse(results="", success=False, error=str(e))

    @app.post("/search-exa", response_model=SearchResponse)
    async def search_exa_endpoint(request: SearchRequest) -> SearchResponse:
        """Search using Exa AI and return formatted results with better relevance and content extraction."""
        if not exa_searcher:
            return SearchResponse(
                results="",
                success=False,
                error="Exa search is not configured. Please set the EXA_API_KEY environment variable.",
            )

        try:
            ctx = SimpleContext()
            results = await exa_searcher.search(request.query, ctx, request.max_results)
            formatted = exa_searcher.format_results_for_llm(results)

            return SearchResponse(results=formatted, success=True)
        except Exception as e:
            return SearchResponse(results="", success=False, error=str(e))

    @app.post("/fetch-content", response_model=FetchContentResponse)
    async def fetch_content_endpoint(
        request: FetchContentRequest,
    ) -> FetchContentResponse:
        """Fetch and parse content from a webpage URL"""
        try:
            ctx = SimpleContext()
            content = await fetcher.fetch_and_parse(request.url, ctx)

            return FetchContentResponse(content=content, success=True)
        except Exception as e:
            return FetchContentResponse(content="", success=False, error=str(e))

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
