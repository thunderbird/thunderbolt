/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Tinfoil

enum ManagedTinfoilConfigurationError: Error, Equatable {
    case invalidBackendURL
    case missingSessionToken
    case missingUserCacheSecret
}

struct ManagedTinfoilProviderConfiguration: Sendable {
    let backendURL: URL
    let userCacheSecret: String
    let appVersion: String
    let deviceID: String?
    let sessionToken: @Sendable () -> String?
    let attestationCallbacks: NativeTinfoilAttestationCallbacks?

    init(
        backendURL: URL,
        userCacheSecret: String,
        appVersion: String,
        deviceID: String? = nil,
        attestationCallbacks: NativeTinfoilAttestationCallbacks? = nil,
        sessionToken: @escaping @Sendable () -> String?
    ) {
        self.backendURL = backendURL
        self.userCacheSecret = userCacheSecret
        self.appVersion = appVersion
        self.deviceID = deviceID
        self.attestationCallbacks = attestationCallbacks
        self.sessionToken = sessionToken
    }
}

enum ManagedTinfoilProvider {
    /// Creates an SDK client that sends EHBP-sealed requests through Thunderbolt's managed relay.
    static func makeClient(
        configuration: ManagedTinfoilProviderConfiguration,
        onEnclaveVerified: EnclaveVerifiedCallback? = nil,
        onVerificationResult: VerificationResultCallback? = nil
    ) async throws -> RouterOpenAIClient {
        guard !configuration.userCacheSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ManagedTinfoilConfigurationError.missingUserCacheSecret
        }
        guard let token = configuration.sessionToken(), !token.isEmpty else {
            throw ManagedTinfoilConfigurationError.missingSessionToken
        }

        var headers = ["X-App-Version": configuration.appVersion]
        if let deviceID = configuration.deviceID, !deviceID.isEmpty {
            headers["X-Device-ID"] = deviceID
        }
        headers["X-Client-Platform"] = "ios"

        let client = try await RouterOpenAIClient(
            baseURL: relayURL(for: configuration.backendURL),
            userCacheSecret: configuration.userCacheSecret,
            onEnclaveVerified: onEnclaveVerified ?? configuration.attestationCallbacks?.onEnclaveVerified,
            onVerificationResult: onVerificationResult ?? configuration.attestationCallbacks?.onVerificationResult,
            apiKeyProvider: configuration.sessionToken,
            customHeaders: headers
        )
        configuration.attestationCallbacks?.onEndpoint(client.httpClient.enclave)
        return client
    }

    /// Resolves the managed inference relay at `<backend URL>/tinfoil`.
    static func relayURL(for backendURL: URL) throws -> URL {
        guard var components = URLComponents(url: backendURL, resolvingAgainstBaseURL: false),
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else { throw ManagedTinfoilConfigurationError.invalidBackendURL }

        let scheme = components.scheme?.lowercased()
        let host = components.host?.lowercased() ?? ""
        let localHTTPHosts: Set<String> = ["localhost", "127.0.0.1", "::1", "[::1]"]
        guard scheme == "https" || (scheme == "http" && localHTTPHosts.contains(host)) else {
            throw ManagedTinfoilConfigurationError.invalidBackendURL
        }

        let prefix = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = prefix.isEmpty ? "/tinfoil" : "/\(prefix)/tinfoil"
        guard let url = components.url else { throw ManagedTinfoilConfigurationError.invalidBackendURL }
        return url
    }
}
