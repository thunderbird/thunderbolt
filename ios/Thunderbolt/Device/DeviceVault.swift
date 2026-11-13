/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation
import Security

/// One atomic record per account and server. Signing out retains device keys so a new
/// session can prove possession; account/device removal explicitly removes the record.
@MainActor
final class DeviceVault {
    private let service: String

    init(service: String = "net.thunderbird.thunderbolt.native.device") {
        self.service = service
    }

    func load<Value: Decodable>(_ type: Value.Type, server: String, userID: String) throws -> Value? {
        var attributes = query(server: server, userID: userID)
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError(status: status) }
        return try JSONDecoder().decode(type, from: data)
    }

    func save<Value: Encodable>(_ value: Value, server: String, userID: String) throws {
        let attributes = query(server: server, userID: userID)
        let values: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(value),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrSynchronizable as String: false,
        ]
        let status = SecItemUpdate(attributes as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            let inserted = SecItemAdd(attributes.merging(values) { _, new in new } as CFDictionary, nil)
            guard inserted == errSecSuccess else { throw KeychainError(status: inserted) }
        } else if status != errSecSuccess { throw KeychainError(status: status) }
    }

    func remove(server: String, userID: String) throws {
        let status = SecItemDelete(query(server: server, userID: userID) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    private func query(server: String, userID: String) -> [String: Any] {
        // Encode a tuple rather than joining with a character that may occur in either value.
        let identity = Data("\(server.utf8.count):\(server)\(userID)".utf8)
        let account = SHA256.hash(data: identity).map { String(format: "%02x", $0) }.joined()
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
}
