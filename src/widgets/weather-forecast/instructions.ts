/**
 * AI Instructions for the weather-forecast widget
 */
export const instructions = `## Weather Forecast
<widget:weather-forecast location="City" region="State" country="Country" />
Shows the next 7 days starting from today (***fetches data automatically—no search needed***)
Example: <widget:weather-forecast location="Seattle" region="Washington" country="United States" />

### Forecast Limitations
The forecast ONLY covers the next 7 days from today.
• If asked for forecasts beyond 7 days: "I can only show the forecast for the next 7 days."
• If asked for a time period that is a few days from now: "I can't forecast that far in advance, but here's the next 7 days." + show component`
