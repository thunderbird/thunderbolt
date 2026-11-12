/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation
import Security

@MainActor
protocol SessionStoring {
    func load(server: String) throws -> CloudSession?
    func save(_ session: CloudSession?, server: String) throws
}

@MainActor
protocol ConversationStoring {
    func load(owner: String) async throws -> [Conversation]
    func save(_ conversations: [Conversation], owner: String) async throws
}

struct KeychainError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { nativeString( "The secure session could not be saved. Please try again.") }
}

/// Stores the signed bearer in this device's unlocked-only Keychain, never UserDefaults.
@MainActor
final class KeychainSessionStore: SessionStoring {
    private let service: String
    init(service: String = "net.thunderbird.thunderbolt.native.session") { self.service = service }

    private func query(server: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service, kSecAttrAccount as String: server]
    }

    func load(server: String) throws -> CloudSession? {
        var attributes = query(server: server)
        attributes[kSecReturnData as String] = true
        attributes[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(attributes as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError(status: status) }
        return try JSONDecoder().decode(CloudSession.self, from: data)
    }

    func save(_ session: CloudSession?, server: String) throws {
        let attributes = query(server: server)
        guard let session else {
            let status = SecItemDelete(attributes as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
            return
        }
        let values: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(session),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemUpdate(attributes as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            let inserted = SecItemAdd(attributes.merging(values) { _, new in new } as CFDictionary, nil)
            guard inserted == errSecSuccess else { throw KeychainError(status: inserted) }
        } else if status != errSecSuccess { throw KeychainError(status: status) }
    }
}

/// Keeps local history isolated by both backend and account, protected by the iOS device lock.
@MainActor
final class FileConversationStore: ConversationStoring {
    let directory: URL
    init(directory: URL = URL.applicationSupportDirectory.appending(path: "Conversations")) {
        self.directory = directory
    }

    private func file(owner: String) -> URL {
        let key = SHA256.hash(data: Data(owner.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appending(path: key + ".json")
    }

    func load(owner: String) throws -> [Conversation] {
        let url = file(owner: owner)
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        return try JSONDecoder().decode([Conversation].self, from: Data(contentsOf: url))
    }

    func save(_ conversations: [Conversation], owner: String) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try JSONEncoder().encode(conversations).write(to: file(owner: owner), options: [.atomic, .completeFileProtection])
        var protectedDirectory = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try protectedDirectory.setResourceValues(values)
    }
}
