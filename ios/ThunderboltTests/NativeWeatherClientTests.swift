/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import XCTest
@testable import Thunderbolt

final class NativeWeatherClientTests: XCTestCase {
    override func tearDown() {
        WeatherURLProtocol.handler = nil
        super.tearDown()
    }

    func testForecastUsesWidgetLocationToDisambiguateThenLoadsFiveDays() async throws {
        let requests = CapturedWeatherRequests()
        WeatherURLProtocol.handler = { request in
            requests.append(request)
            if request.url?.host == "geocoding-api.open-meteo.com" {
                return Self.response(request, status: 200, body: #"{"results":[{"id":1,"name":"Springfield","admin1":"Illinois","country":"United States","latitude":39.8,"longitude":-89.6},{"id":2,"name":"Springfield","admin1":"Missouri","country":"United States","latitude":37.2,"longitude":-93.3}]}"#)
            }
            return Self.response(request, status: 200, body: #"{"daily":{"time":["2026-11-11","2026-11-12"],"weather_code":[1,61],"temperature_2m_max":[14.5,10.0]}}"#)
        }

        let result = try await Self.client().forecast(location: "Springfield", region: "Missouri", country: "United States")

        XCTAssertEqual(result.map(\.temperatureCelsius), [14.5, 10.0])
        XCTAssertEqual(result.first?.code, 1)
        XCTAssertEqual(requests.all.count, 2)
        let forecastURL = try XCTUnwrap(requests.all.last?.url)
        let query = URLComponents(url: forecastURL, resolvingAgainstBaseURL: false)?.queryItems
        XCTAssertEqual(query?.first(where: { $0.name == "latitude" })?.value, "37.2")
        XCTAssertEqual(query?.first(where: { $0.name == "longitude" })?.value, "-93.3")
        XCTAssertEqual(query?.first(where: { $0.name == "forecast_days" })?.value, "5")
        XCTAssertEqual(query?.first(where: { $0.name == "temperature_unit" })?.value, "celsius")
    }

    func testGeocodingFallsBackToFirstCandidateWhenFiltersHaveNoMatch() async throws {
        WeatherURLProtocol.handler = { request in
            if request.url?.host == "geocoding-api.open-meteo.com" {
                return Self.response(request, status: 200, body: #"{"results":[{"id":1,"name":"Paris","admin1":"Île-de-France","country":"France","latitude":48.8,"longitude":2.3}]}"#)
            }
            return Self.response(request, status: 200, body: #"{"daily":{"time":["2026-11-11"],"weather_code":[0],"temperature_2m_max":[19.0]}}"#)
        }

        let days = try await Self.client().forecast(location: "Paris", region: "Texas", country: "United States")

        XCTAssertEqual(days.count, 1)
        XCTAssertEqual(days.first?.temperatureCelsius, 19)
    }

    func testNonSuccessHttpResponseSurfacesWeatherError() async {
        WeatherURLProtocol.handler = { request in
            Self.response(request, status: 503, body: "service unavailable")
        }

        do {
            _ = try await Self.client().forecast(location: "Seattle", region: "Washington", country: "United States")
            XCTFail("Expected HTTP failure")
        } catch {
            XCTAssertEqual(error as? NativeWeatherError, .invalidResponse)
        }
    }

    private static func client() -> NativeWeatherClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WeatherURLProtocol.self]
        return NativeWeatherClient(session: URLSession(configuration: configuration))
    }

    private static func response(_ request: URLRequest, status: Int, body: String) -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, Data(body.utf8))
    }
}

private final class WeatherURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler, let client else { return }
        let (response, data) = handler(request)
        client.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client.urlProtocol(self, didLoad: data)
        client.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class CapturedWeatherRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [URLRequest] = []

    var all: [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return requests
    }

    func append(_ request: URLRequest) {
        lock.lock()
        requests.append(request)
        lock.unlock()
    }
}
