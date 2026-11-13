/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct NativeWeatherLocation: Decodable, Equatable, Sendable {
    let id: Int
    let name: String
    let admin1: String?
    let country: String?
    let latitude: Double
    let longitude: Double
}

struct NativeWeatherDay: Decodable, Equatable, Identifiable, Sendable {
    let date: String
    let temperatureCelsius: Double
    let code: Int
    var id: String { date }

    var symbol: String {
        switch code {
        case 0: "sun.max.fill"
        case 1, 2: "cloud.sun.fill"
        case 3: "cloud.fill"
        case 45, 48: "cloud.fog.fill"
        case 51...67: "cloud.drizzle.fill"
        case 71...77, 85, 86: "cloud.snow.fill"
        case 80...82: "cloud.rain.fill"
        case 95...99: "cloud.bolt.rain.fill"
        default: "cloud.fill"
        }
    }

    var description: String {
        switch code {
        case 0: nativeString( "Clear")
        case 1, 2: nativeString( "Partly cloudy")
        case 3: nativeString( "Overcast")
        case 45, 48: nativeString( "Fog")
        case 51...67: nativeString( "Drizzle or rain")
        case 71...77, 85, 86: nativeString( "Snow")
        case 80...82: nativeString( "Rain showers")
        case 95...99: nativeString( "Thunderstorms")
        default: nativeString( "Conditions unavailable")
        }
    }
}

struct NativeWeatherClient: Sendable {
    let session: URLSession
    private let geocodingURL = URL(string: "https://geocoding-api.open-meteo.com/v1/search")!
    private let forecastURL = URL(string: "https://api.open-meteo.com/v1/forecast")!

    init(session: URLSession = .shared) {
        self.session = session
    }

    func forecast(location: String, region: String, country: String, days: Int = 5) async throws -> [NativeWeatherDay] {
        var geocoding = URLComponents(url: geocodingURL, resolvingAgainstBaseURL: false)!
        geocoding.queryItems = [
            URLQueryItem(name: "name", value: location),
            URLQueryItem(name: "count", value: "10"),
            URLQueryItem(name: "language", value: "en"),
            URLQueryItem(name: "format", value: "json"),
        ]
        let geoResponse: GeocodingResponse = try await get(geocoding.url!)
        let locations = geoResponse.results ?? []
        let byRegion = narrow(locations) { $0.admin1?.localizedCaseInsensitiveContains(region) ?? false }
        let matches = country.isEmpty ? byRegion : narrow(byRegion) { $0.country?.localizedCaseInsensitiveContains(country) ?? false }
        guard let selected = matches.first else { throw NativeWeatherError.locationUnavailable }

        var forecast = URLComponents(url: forecastURL, resolvingAgainstBaseURL: false)!
        forecast.queryItems = [
            URLQueryItem(name: "latitude", value: String(selected.latitude)),
            URLQueryItem(name: "longitude", value: String(selected.longitude)),
            URLQueryItem(name: "daily", value: "weather_code,temperature_2m_max"),
            URLQueryItem(name: "forecast_days", value: String(days)),
            URLQueryItem(name: "timezone", value: "auto"),
            URLQueryItem(name: "temperature_unit", value: "celsius"),
        ]
        let response: ForecastResponse = try await get(forecast.url!)
        let daily = response.daily
        let result = daily.time.indices.prefix(days).compactMap { index -> NativeWeatherDay? in
            guard index < daily.temperature_2m_max.count else { return nil }
            return NativeWeatherDay(
                date: daily.time[index],
                temperatureCelsius: daily.temperature_2m_max[index],
                code: daily.weather_code[safe: index] ?? 0
            )
        }
        guard !result.isEmpty else { throw NativeWeatherError.forecastUnavailable }
        return result
    }

    private func get<Response: Decodable & Sendable>(_ url: URL) async throws -> Response {
        let (data, response) = try await session.data(from: url)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            throw NativeWeatherError.invalidResponse
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }

    private func narrow(_ locations: [NativeWeatherLocation], matching predicate: (NativeWeatherLocation) -> Bool) -> [NativeWeatherLocation] {
        guard !regionlessFallback(locations, predicate: predicate).isEmpty else { return locations }
        return locations.filter(predicate)
    }

    private func regionlessFallback(_ locations: [NativeWeatherLocation], predicate: (NativeWeatherLocation) -> Bool) -> [NativeWeatherLocation] {
        locations.filter(predicate)
    }
}

private struct GeocodingResponse: Decodable, Sendable {
    let results: [NativeWeatherLocation]?
}

private struct ForecastResponse: Decodable, Sendable {
    let daily: Daily
    struct Daily: Decodable, Sendable {
        let time: [String]
        let weather_code: [Int]
        let temperature_2m_max: [Double]
    }
}

enum NativeWeatherError: LocalizedError, Equatable, Sendable {
    case locationUnavailable
    case forecastUnavailable
    case invalidResponse

    var errorDescription: String? {
        switch self {
        case .locationUnavailable: nativeString( "Could not find coordinates for that location.")
        case .forecastUnavailable: nativeString( "Forecast unavailable")
        case .invalidResponse: nativeString( "The weather service returned an invalid response.")
        }
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? { indices.contains(index) ? self[index] : nil }
}
