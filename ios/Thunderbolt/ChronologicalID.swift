/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

/// UUIDv7 matches Tauri's ordering and timestamp extraction. A bounded counter makes
/// messages created in one millisecond ordered even if the wall clock moves backwards.
final class ChronologicalID: @unchecked Sendable {
    private let lock = NSLock()
    private var lastMilliseconds: UInt64 = 0
    private var sequence: UInt16 = 0
    static let shared = ChronologicalID()

    func next(at date: Date = Date()) -> String {
        lock.lock()
        defer { lock.unlock() }
        let milliseconds = UInt64(max(0, date.timeIntervalSince1970 * 1_000))
        var random = UUID().uuid
        var bytes = withUnsafeBytes(of: &random) { Array($0) }
        if milliseconds > lastMilliseconds {
            lastMilliseconds = milliseconds
            sequence = (UInt16(bytes[6] & 0x0f) << 8) | UInt16(bytes[7])
        } else if sequence < 0x0fff {
            sequence += 1
        } else {
            lastMilliseconds += 1
            sequence = 0
        }
        for index in 0..<6 { bytes[index] = UInt8(truncatingIfNeeded: lastMilliseconds >> ((5 - index) * 8)) }
        bytes[6] = 0x70 | UInt8(sequence >> 8)
        bytes[7] = UInt8(truncatingIfNeeded: sequence)
        bytes[8] = 0x80 | (bytes[8] & 0x3f)
        let hex = bytes.map { String(format: "%02x", $0) }
        return [hex[0..<4].joined(), hex[4..<6].joined(), hex[6..<8].joined(),
                hex[8..<10].joined(), hex[10..<16].joined()].joined(separator: "-")
    }

    static func date(from id: String) -> Date? {
        guard let uuid = UUID(uuidString: id) else { return nil }
        var raw = uuid.uuid
        let bytes = withUnsafeBytes(of: &raw) { Array($0) }
        guard bytes[6] >> 4 == 7, bytes[8] >> 6 == 2 else { return nil }
        let milliseconds = bytes.prefix(6).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        return Date(timeIntervalSince1970: Double(milliseconds) / 1_000)
    }
}
