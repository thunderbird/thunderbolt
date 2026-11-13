// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import Foundation
import Darwin
import PowerSync

struct NativeSyncOperation: Encodable, Sendable {
    let op: String
    let type: String
    let id: String
    let data: JsonParam?
}

protocol NativeSyncTransport: Sendable {
    func fetchCredentials() async throws -> PowerSyncCredentials?
    func upload(_ operations: [NativeSyncOperation]) async throws
}

/// The PowerSync connector is deliberately unusable until the store confirms both
/// trusted-device status and an initialized encryption codec. Returning no token
/// keeps the local queue intact while setup is incomplete.
struct NativePowerSyncConnector: PowerSyncBackendConnectorProtocol {
    private let store: NativeSyncStore
    private let transport: any NativeSyncTransport

    init(store: NativeSyncStore, transport: any NativeSyncTransport) {
        self.store = store
        self.transport = transport
    }

    func fetchCredentials() async throws -> PowerSyncCredentials? {
        guard await store.readiness == .ready else { return nil }
        let credentials = try await transport.fetchCredentials()
        guard await store.readiness == .ready else { return nil }
        return credentials
    }

    func uploadData(database: any PowerSyncDatabaseProtocol) async throws {
        guard await store.readiness == .ready else {
            throw NativeSyncStoreError.syncNotReady(await store.readiness)
        }

        while let batch = try await database.getCrudBatch(limit: 100) {
            let operations = batch.crud.map { entry -> NativeSyncOperation in
                NativeSyncOperation(
                    op: entry.op.rawValue,
                    type: entry.table,
                    id: entry.id,
                    data: entry.opDataTyped
                )
            }
            for operation in operations { try await store.validateForUpload(operation) }
            guard await store.readiness == .ready else {
                throw NativeSyncStoreError.syncNotReady(await store.readiness)
            }
            try await transport.upload(operations)
            try await batch.complete()
            if !batch.hasMore { return }
        }
    }
}

/// Authenticated transport for the existing backend `/powersync/token` and
/// `/powersync/upload` endpoints. Account/session and device identity are supplied
/// by the app lifecycle, not persisted in the sync database.
struct NativePowerSyncHTTPTransport: NativeSyncTransport {
    private let backendURL: URL
    private let accountID: String
    private let sessionToken: @Sendable () async throws -> String?
    private let deviceID: @Sendable () async throws -> String?
    private let deviceName: String
    private let appVersion: String
    private let session: URLSession
    private let onAccessInvalidation: @Sendable (NativeAccountAccess) async -> Void

    init(
        backendURL: URL,
        accountID: String,
        deviceName: String,
        appVersion: String,
        sessionToken: @escaping @Sendable () async throws -> String?,
        deviceID: @escaping @Sendable () async throws -> String?,
        session: URLSession? = nil,
        onAccessInvalidation: @escaping @Sendable (NativeAccountAccess) async -> Void = { _ in }
    ) {
        self.backendURL = backendURL
        self.accountID = accountID
        self.deviceName = deviceName
        self.appVersion = appVersion
        self.sessionToken = sessionToken
        self.deviceID = deviceID
        self.session = session ?? URLSession(configuration: .ephemeral, delegate: SameOriginRedirectDelegate(origin: backendURL), delegateQueue: nil)
        self.onAccessInvalidation = onAccessInvalidation
    }

    func fetchCredentials() async throws -> PowerSyncCredentials? {
        guard let token = try await sessionToken(), let deviceID = try await deviceID() else { return nil }
        var request = URLRequest(url: backendURL.appending(path: "powersync/token"))
        request.httpMethod = "GET"
        addAppHeaders(to: &request, token: token, deviceID: deviceID)
        let response = try await perform(request)
        if response.statusCode == 404 { return nil }
        guard (200..<300).contains(response.statusCode) else { throw NativeSyncHTTPError.status(response.statusCode, Self.safeServerMessage(response.data)) }
        let payload = try JSONDecoder().decode(PowerSyncTokenResponse.self, from: response.data)
        guard Self.tokenSubject(payload.token) == accountID else { throw NativeSyncHTTPError.accountMismatch }
        guard Self.isSecurePowerSyncEndpoint(payload.powerSyncURL) else {
            throw NativeSyncHTTPError.insecurePowerSyncEndpoint
        }
        return PowerSyncCredentials(endpoint: payload.powerSyncURL, token: payload.token)
    }

    /// The sync service verifies the signature. This local claim check prevents
    /// handing one account's token to a database owned by another account.
    static func tokenSubject(_ token: String) -> String? {
        let segments = token.split(separator: ".", omittingEmptySubsequences: false)
        guard segments.count == 3 else { return nil }
        var payload = String(segments[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let bytes = Data(base64Encoded: payload),
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return nil }
        return object["sub"] as? String
    }

    func upload(_ operations: [NativeSyncOperation]) async throws {
        guard let token = try await sessionToken(), let deviceID = try await deviceID() else {
            throw NativeSyncHTTPError.unauthenticated
        }
        var request = URLRequest(url: backendURL.appending(path: "powersync/upload"))
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(PowerSyncUploadRequest(operations: operations))
        addAppHeaders(to: &request, token: token, deviceID: deviceID)
        let response = try await perform(request)
        guard (200..<300).contains(response.statusCode) else { throw NativeSyncHTTPError.status(response.statusCode, Self.safeServerMessage(response.data)) }
        guard (try? JSONDecoder().decode(PowerSyncUploadResponse.self, from: response.data).success) == true else {
            throw NativeSyncHTTPError.invalidResponse
        }
    }

    private func addAppHeaders(to request: inout URLRequest, token: String, deviceID: String) {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(deviceID, forHTTPHeaderField: "X-Device-ID")
        request.setValue(deviceName, forHTTPHeaderField: "X-Device-Name")
        request.setValue(appVersion, forHTTPHeaderField: "X-App-Version")
    }

    private func perform(_ request: URLRequest) async throws -> (data: Data, statusCode: Int) {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse,
              Self.isSameOrigin(response.url, as: backendURL)
        else { throw NativeSyncHTTPError.invalidResponse }
        if let reason = NativeAccountAccess.decode(status: response.statusCode, data: data) {
            await onAccessInvalidation(reason)
        }
        return (data, response.statusCode)
    }

    private static func safeServerMessage(_ data: Data) -> String {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "" }
        return ["message", "error", "code"].compactMap { object[$0] as? String }.first ?? ""
    }

    fileprivate static func isSameOrigin(_ left: URL?, as right: URL) -> Bool {
        guard let left,
              let lhs = URLComponents(url: left, resolvingAgainstBaseURL: false),
              let rhs = URLComponents(url: right, resolvingAgainstBaseURL: false)
        else { return false }
        return lhs.scheme?.lowercased() == rhs.scheme?.lowercased() &&
            lhs.host?.lowercased() == rhs.host?.lowercased() &&
            (lhs.port ?? (lhs.scheme == "https" ? 443 : 80)) == (rhs.port ?? (rhs.scheme == "https" ? 443 : 80))
    }

    static func isSecurePowerSyncEndpoint(_ endpoint: String) -> Bool {
        guard let url = URL(string: endpoint),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil,
              components.password == nil,
              let rawHost = components.host?.lowercased(),
              !rawHost.isEmpty
        else { return false }

        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if components.scheme?.lowercased() == "https" { return true }
        guard components.scheme?.lowercased() == "http" else { return false }
        if host == "localhost" || host.hasSuffix(".localhost") || host == "::1" { return true }

        var address = in_addr()
        guard host.withCString({ inet_pton(AF_INET, $0, &address) }) == 1 else { return false }
        return UInt32(bigEndian: address.s_addr) >> 24 == 127
    }
}

private struct PowerSyncTokenResponse: Decodable {
    let token: String
    let expiresAt: String
    let powerSyncURL: String

    enum CodingKeys: String, CodingKey {
        case token
        case expiresAt
        case powerSyncURL = "powerSyncUrl"
    }
}

private struct PowerSyncUploadRequest: Encodable {
    let operations: [NativeSyncOperation]
}

private struct PowerSyncUploadResponse: Decodable {
    let success: Bool
}

enum NativeSyncHTTPError: Error, Equatable {
    case unauthenticated
    case invalidResponse
    case insecurePowerSyncEndpoint
    case accountMismatch
    case status(Int, String)
}

private final class SameOriginRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let origin: URL

    init(origin: URL) { self.origin = origin }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard NativePowerSyncHTTPTransport.isSameOrigin(request.url, as: origin) else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }
}
