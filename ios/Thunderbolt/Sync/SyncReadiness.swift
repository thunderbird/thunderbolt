// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import Foundation

/// Explicitly describes what must be available before encrypted account sync can start.
enum NativeSyncReadiness: Equatable, Sendable {
    case localOnly
    case waitingForTrustedDevice
    case waitingForCodec
    case ready
    case failed(String)

    var canSync: Bool { self == .ready }
}
