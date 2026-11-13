/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct CloudUser: Codable, Sendable, Equatable {
    let id: String
    let name: String
    let email: String
    var isAnonymous: Bool? = nil
}

struct CloudSession: Codable, Sendable, Equatable {
    var token: String
    var user: CloudUser
}

enum MessageRole: String, Codable, Sendable { case user, assistant, system }

struct ChatMessage: Codable, Identifiable, Sendable, Equatable {
    var id = ChronologicalID.shared.next()
    var role: MessageRole
    var text: String
    var createdAt = Date()
    var deletedAt: Date?
    var parts: [ChatContentPart]?
    var metadata: ChatJSONValue?
    var cache: ChatJSONValue?
    var parentID: String?
    var modelID: String?
}

struct Conversation: Codable, Identifiable, Sendable, Equatable {
    var id = ChronologicalID.shared.next()
    var title: String
    var updatedAt = Date()
    var deletedAt: Date?
    var messages: [ChatMessage] = []
    var modelID: String?
    var agentID: String?
    var projectID: String?
    var isPrivate: Bool? = nil
    var contextSize: Int64? = nil
}

struct ChatModel: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let model: String
    let vendor: String?
    let endpoint: String?
    var usesHostedAgent: Bool { endpoint != nil }
    var detail: String {
        usesHostedAgent ? nativeString( "Cloud agent") : nativeString( "Thunderbolt Cloud")
    }
}

enum ChatStreamEvent: Sendable {
    case text(String)
    case content(parts: [ChatContentPart], metadata: ChatJSONValue)
    case status(String)
    case finished
}

enum CloudError: Error, LocalizedError, Equatable, Sendable {
    case http(Int, String)
    case invalidResponse, missingToken, interrupted, noModels, invalidServer

    var errorDescription: String? {
        switch self {
        case .http(401, _): nativeString( "Your session has expired. Please sign in again.")
        case .http(403, _): nativeString( "Your account does not have access to this service.")
        case .http(402, _): nativeString( "Your Cloud usage allowance has been reached.")
        case .http(426, _): nativeString( "This app needs an update to connect to Thunderbolt Cloud.")
        case .http(429, _): nativeString( "Too many requests. Please wait a moment and try again.")
        case .http(_, let message): message.isEmpty ? nativeString( "The server could not complete the request.") : message
        case .invalidResponse: nativeString( "The server returned an unexpected response.")
        case .missingToken: nativeString( "Sign-in did not return a session. Please try again.")
        case .interrupted: nativeString( "The response was interrupted. You can retry it.")
        case .noModels: nativeString( "No compatible chat models are available on this server.")
        case .invalidServer: nativeString( "Enter an HTTPS server address. HTTP is supported only for localhost development.")
        }
    }
}

/// Canonicalizes the API base before any credential can be sent to it.
enum ServerAddress {
    static let cloud = "https://api.thunderbolt.io/v1"

    static func normalize(_ input: String) throws -> URL {
        guard var parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil else {
            throw CloudError.invalidServer
        }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host)
        guard parts.scheme == "https" || (parts.scheme == "http" && loopback) else {
            throw CloudError.invalidServer
        }
        var path = parts.path
        while path.hasSuffix("/") { path.removeLast() }
        if !path.hasSuffix("/v1") { path += "/v1" }
        parts.path = path
        guard let url = parts.url else { throw CloudError.invalidServer }
        return url
    }
}
