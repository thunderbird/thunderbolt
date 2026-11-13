/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

enum NativeAccountAccess: Sendable, Equatable {
    case accountDeleted, deviceRevoked, deviceIDTaken, deviceIDRequired, sessionExpired, syncNotPermitted

    var requiresErase: Bool {
        switch self {
        case .accountDeleted, .deviceRevoked, .deviceIDTaken, .deviceIDRequired: true
        case .sessionExpired, .syncNotPermitted: false
        }
    }

    static func decode(status: Int, data: Data) -> Self? {
        let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["code"] as? String
        switch (status, code) {
        case (410, _): return .accountDeleted
        case (403, "DEVICE_DISCONNECTED"): return .deviceRevoked
        case (403, "ANONYMOUS_SYNC_FORBIDDEN"): return .syncNotPermitted
        case (409, "DEVICE_ID_TAKEN"): return .deviceIDTaken
        case (400, "DEVICE_ID_REQUIRED"): return .deviceIDRequired
        case (401, _): return .sessionExpired
        default: return nil
        }
    }
}

/// A cold database has no device row yet. Only disappearance after observing
/// this account's own row proves deletion; another account's row never does.
struct NativeDeviceAccessMonitor {
    private var hasSeenDevice = false

    mutating func observe(_ rows: [NativeSyncRow], deviceID: String, userID: String) -> NativeAccountAccess? {
        guard let own = rows.first(where: { $0.id == deviceID && $0.values["user_id"] == .text(userID) }) else {
            return hasSeenDevice ? .accountDeleted : nil
        }
        hasSeenDevice = true
        return own.values["revoked_at"]?.text == nil ? nil : .deviceRevoked
    }
}
