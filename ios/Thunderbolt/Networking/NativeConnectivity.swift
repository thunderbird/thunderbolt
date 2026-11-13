/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import Network

enum NativeConnectivity {
    /// Initial startup is handled by restore(); only an unavailable→available
    /// transition requests a fresh session and device binding.
    static func restoredConnections() -> AsyncStream<Void> {
        AsyncStream { continuation in
            let monitor = NWPathMonitor()
            let state = ConnectivityState()
            monitor.pathUpdateHandler = { path in
                if state.update(available: path.status == .satisfied) { continuation.yield(()) }
            }
            continuation.onTermination = { _ in monitor.cancel() }
            monitor.start(queue: DispatchQueue(label: "net.thunderbird.thunderbolt.connectivity"))
        }
    }
}

private final class ConnectivityState: @unchecked Sendable {
    // Only accessed by NWPathMonitor's serial delivery queue.
    private var wasAvailable: Bool?
    func update(available: Bool) -> Bool {
        defer { wasAvailable = available }
        return wasAvailable == false && available
    }
}
