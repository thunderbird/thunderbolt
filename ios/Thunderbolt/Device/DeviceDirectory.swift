/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct NativeAccountDevice: Identifiable, Sendable, Equatable {
    let id: String
    let name: String
    let publicKey: String?
    let mlkemPublicKey: String?
    let trusted: Bool
    let approvalPending: Bool
    let deviceType: String
    let revokedAt: String?

    var isAppDevice: Bool { deviceType != "cli" }
    var canApprove: Bool { trusted && revokedAt == nil && isAppDevice }

    func approvalAnchor(userID: String) throws -> DeviceApprovalAnchor {
        guard let publicKey, let mlkemPublicKey else { throw DeviceTrustError.incompleteMetadata }
        return DeviceApprovalAnchor(userID: userID, deviceID: id, ecdhPublicKey: publicKey, mlkemPublicKey: mlkemPublicKey)
    }
}

extension NativeSyncStore {
    /// Reads the synced device directory through the decrypted repository boundary.
    /// The explicit owner check prevents stale rows from a previous account being
    /// offered as approval targets.
    func accountDevices(ownerID: String) async throws -> [NativeAccountDevice] {
        try await readAll(table: "devices", includeDeleted: true)
            .filter { $0.values.text("user_id") == ownerID }
            .map { row in
                NativeAccountDevice(
                    id: row.id,
                    name: row.values.text("name") ?? nativeString( "Unnamed device"),
                    publicKey: row.values.text("public_key"),
                    mlkemPublicKey: row.values.text("mlkem_public_key"),
                    trusted: row.values.integer("trusted") == 1,
                    approvalPending: row.values.integer("approval_pending") == 1,
                    deviceType: row.values.text("device_type") ?? "normal",
                    revokedAt: row.values.text("revoked_at")
                )
            }
            .sorted { lhs, rhs in
                if lhs.trusted != rhs.trusted { return lhs.trusted }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
    }
}

private extension Dictionary where Key == String, Value == NativeSyncValue {
    func text(_ column: String) -> String? {
        guard case .text(let value)? = self[column] else { return nil }
        return value
    }

    func integer(_ column: String) -> Int64? {
        guard case .integer(let value)? = self[column] else { return nil }
        return value
    }
}
