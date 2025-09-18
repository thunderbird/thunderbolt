"""
Pydantic models for Pro Tools API requests and responses
"""

from pydantic import BaseModel


# Request/Response models
class SearchRequest(BaseModel):
    query: str
    max_results: int = 10


class SearchResponse(BaseModel):
    results: str
    success: bool
    error: str | None = None


class FetchContentRequest(BaseModel):
    url: str


class FetchContentResponse(BaseModel):
    content: str
    success: bool
    error: str | None = None


class WeatherRequest(BaseModel):
    location: str
    days: int = 3  # Only used for forecast


class WeatherDay(BaseModel):
    date: str
    weather_code: int
    temperature_max: float
    temperature_min: float
    apparent_temperature_max: float
    apparent_temperature_min: float
    precipitation_sum: float
    precipitation_probability_max: int
    wind_speed_10m_max: float


class WeatherForecastData(BaseModel):
    location: str
    days: list[WeatherDay]


class WeatherResponse(BaseModel):
    weather_data: str | None = None
    data: WeatherForecastData | None = None
    success: bool
    error: str | None = None


class LocationSearchRequest(BaseModel):
    query: str


class LocationSearchResponse(BaseModel):
    locations: str
    success: bool
    error: str | None = None
