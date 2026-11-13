/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Security

protocol NativeIrohIdentityStoring: Sendable {
    func load() async throws -> Data?
    func save(_ key: Data) async throws
    func remove() async throws
}

enum NativeIrohIdentityError: Error, LocalizedError, Sendable {
    case keychain(OSStatus)
    case invalidKey

    var errorDescription: String? {
        switch self {
        case .keychain: "The secure iroh identity could not be accessed."
        case .invalidKey: "The stored iroh identity is invalid."
        }
    }
}

/// Keeps the stable 32-byte iroh secret key in this device's unlocked-only Keychain.
actor KeychainNativeIrohIdentityStore: NativeIrohIdentityStoring {
    private let service: String
    private let account: String

    init(
        service: String = "net.thunderbird.thunderbolt.native.iroh",
        account: String = "client-identity"
    ) {
        self.service = service
        self.account = account
    }

    func load() async throws -> Data? {
        var attributes = query
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw NativeIrohIdentityError.keychain(status)
        }
        return data
    }

    func save(_ key: Data) async throws {
        guard key.count == 32 else { throw NativeIrohIdentityError.invalidKey }
        let attributes = query
        let values: [String: Any] = [
            kSecValueData as String: key,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(attributes as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            let inserted = SecItemAdd(attributes.merging(values) { _, new in new } as CFDictionary, nil)
            guard inserted == errSecSuccess else { throw NativeIrohIdentityError.keychain(inserted) }
        } else if status != errSecSuccess {
            throw NativeIrohIdentityError.keychain(status)
        }
    }

    func remove() async throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NativeIrohIdentityError.keychain(status)
        }
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
