/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * AI Instructions for the weather-forecast widget
 */
export const instructions = `## Weather Forecast
<widget:weather-forecast location="City" region="State" country="Country" />
Shows today + the next 5 days (***fetches data automatically—no search needed***)
Example: <widget:weather-forecast location="Seattle" region="Washington" country="United States" />

### Forecast Limitations
The forecast covers today and the next 5 days (6 days total).
• If asked for forecasts beyond 6 days: "I can only show the forecast for the next 6 days."
• If asked for a time period that is a few days from now: "I can't forecast that far in advance, but here's the next 6 days." + show component`
