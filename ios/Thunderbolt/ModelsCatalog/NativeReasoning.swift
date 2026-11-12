/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct NativeReasoningCapabilities: Codable, Sendable, Equatable {
    var kind: String?
    let efforts: [String]
    static let orderedEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
}

struct NativeReasoningResolution: Decodable, Sendable, Equatable {
    let capabilities: NativeReasoningCapabilities
    let preference: String?
    let requestEffort: String?
    let profileEffort: String?
    let profileConfigured: Bool
    let preferredEffort: String?
    let thinkingLevel: String
}

/// Provider metadata is public and cached independently from account credentials.
/// Pending requests are shared; a refresh failure keeps the last successful catalog.
actor NativeReasoningCatalog {
    private struct Entry {
        let task: Task<[String: NativeReasoningCapabilities], Error>
        var expires: Date
    }
    private let session: URLSession
    private var entries: [String: Entry] = [:]

    init(session: URLSession = .shared) { self.session = session }

    func capabilities(provider: String, modelID: String) async throws -> NativeReasoningCapabilities? {
        guard provider == "tinfoil" || provider == "openrouter" else { return nil }
        if let cached = entries[provider], cached.expires > Date() {
            return try await cached.task.value[modelID] ?? NativeReasoningCapabilities(efforts: [])
        }
        let previous = entries[provider]
        let session = session
        let task = Task {
            do {
                let address = provider == "tinfoil"
                    ? "https://inference.tinfoil.sh/v1/models" : "https://openrouter.ai/api/v1/models"
                var request = URLRequest(url: URL(string: address)!)
                request.timeoutInterval = 10
                let (data, response) = try await session.data(for: request)
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                    throw CloudError.invalidResponse
                }
                return try Self.parse(data, provider: provider)
            } catch {
                if let previous { return try await previous.task.value }
                throw error
            }
        }
        entries[provider] = Entry(task: task, expires: .distantFuture)
        do {
            let catalog = try await task.value
            entries[provider]?.expires = Date().addingTimeInterval(300)
            return catalog[modelID] ?? NativeReasoningCapabilities(efforts: [])
        } catch {
            entries[provider] = nil
            throw error
        }
    }

    static func parse(_ data: Data, provider: String) throws -> [String: NativeReasoningCapabilities] {
        let document = try JSONDecoder().decode(ChatJSONValue.self, from: data)
        guard let rows = document["data"]?.arrayValue else { throw CloudError.invalidResponse }
        var result: [String: NativeReasoningCapabilities] = [:]
        for row in rows {
            guard let id = row["id"]?.stringValue else { throw CloudError.invalidResponse }
            let efforts: [String]
            if provider == "tinfoil" {
                if let reasoning = row["reasoning"], reasoning != .null, reasoning.boolValue == nil {
                    throw CloudError.invalidResponse
                }
                let supported = row["supported_efforts"]
                if let supported, supported != .null,
                   supported.arrayValue == nil || supported.arrayValue?.contains(where: { $0.stringValue == nil }) == true {
                    throw CloudError.invalidResponse
                }
                let offered = row["reasoning"]?.boolValue == true ? supported?.arrayValue?.compactMap(\.stringValue) ?? [] : []
                efforts = NativeReasoningCapabilities.orderedEfforts.filter(offered.contains)
            } else {
                let reasoning = row["reasoning"]
                let supported = reasoning?["supported_efforts"]
                let offered = supported?.arrayValue?.compactMap(\.stringValue) ?? []
                efforts = NativeReasoningCapabilities.orderedEfforts.filter {
                    !($0 == "none" && reasoning?["mandatory"]?.boolValue == true) &&
                    (supported == .null || offered.contains($0))
                }
            }
            result[id] = NativeReasoningCapabilities(efforts: efforts)
        }
        return result
    }
}
