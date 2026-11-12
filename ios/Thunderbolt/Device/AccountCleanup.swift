/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct DeletedAccountCleanup: Codable, Equatable {
    let server: String
    let userID: String
    let owner: String
    let preferenceKey: String
}

@MainActor
enum AccountCleanup {
    /// A failed erase must not leave the remaining stores untouched. All steps
    /// run, and the durable journal remains until every step has succeeded.
    static func run(_ steps: [@MainActor () async throws -> Void]) async throws {
        var firstError: Error?
        for step in steps {
            do { try await step() }
            catch { if firstError == nil { firstError = error } }
        }
        if let firstError { throw firstError }
    }

    static func pending(in defaults: UserDefaults) throws -> [DeletedAccountCleanup] {
        guard let data = defaults.data(forKey: "pendingDeletedAccountCleanup") else { return [] }
        return try JSONDecoder().decode([DeletedAccountCleanup].self, from: data)
    }

    static func record(_ account: DeletedAccountCleanup, in defaults: UserDefaults) throws {
        commit(try prepare(account, in: defaults), in: defaults)
    }

    /// Resolve fallible journal decoding before requesting irreversible server
    /// deletion. Committing the prepared bytes afterwards cannot throw.
    static func prepare(_ account: DeletedAccountCleanup, in defaults: UserDefaults) throws -> Data {
        var accounts = try pending(in: defaults)
        if !accounts.contains(account) { accounts.append(account) }
        return try JSONEncoder().encode(accounts)
    }

    static func commit(_ data: Data, in defaults: UserDefaults) {
        defaults.set(data, forKey: "pendingDeletedAccountCleanup")
    }

    static func finish(_ account: DeletedAccountCleanup, in defaults: UserDefaults) throws {
        let remaining = try pending(in: defaults).filter { $0 != account }
        if remaining.isEmpty { defaults.removeObject(forKey: "pendingDeletedAccountCleanup") }
        else { defaults.set(try JSONEncoder().encode(remaining), forKey: "pendingDeletedAccountCleanup") }
    }
}
