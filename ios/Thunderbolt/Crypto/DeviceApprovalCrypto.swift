/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation

struct DeviceApprovalAnchor: Sendable, Equatable {
    let userID: String
    let deviceID: String
    let ecdhPublicKey: String
    let mlkemPublicKey: String
}

struct DeviceApprovalConfirmation: Sendable, Equatable {
    let sessionID: String
    let commitment: String
    let challenge: String
    let reveal: String
    let code: String
}

enum DeviceApprovalCrypto {
    static func newSessionID() throws -> String { try ThunderboltCrypto.randomBytes(count: 16).hex }
    static func newNonce() throws -> String { try ThunderboltCrypto.randomBytes(count: 32).hex }

    static func canonicalize(_ anchor: DeviceApprovalAnchor) throws -> DeviceApprovalAnchor {
        let ecdhText = anchor.ecdhPublicKey.filter { !" \t\n\r\u{000c}".contains($0) }
        guard let ecdhBytes = Data(base64Encoded: ecdhText) else { throw CryptoFailure.malformedValue }
        let ecdh = try P256.KeyAgreement.PublicKey(x963Representation: ecdhBytes)

        let mlkemText = anchor.mlkemPublicKey.filter { !" \t\n\r\u{000c}".contains($0) }
        guard let mlkemBytes = Data(base64Encoded: mlkemText), mlkemBytes.count == 1184,
              try NobleCryptoBridge.shared.invoke("validatePublicKey", [mlkemText]) == "valid" else {
            throw CryptoFailure.malformedValue
        }
        return DeviceApprovalAnchor(
            userID: anchor.userID,
            deviceID: anchor.deviceID,
            ecdhPublicKey: ecdh.x963Representation.base64EncodedString(),
            mlkemPublicKey: mlkemBytes.base64EncodedString()
        )
    }

    static func fingerprint(_ anchor: DeviceApprovalAnchor) throws -> String {
        let anchor = try canonicalize(anchor)
        let payload = try jsonArray([
            "thunderbolt-device-approval-v1", anchor.userID, anchor.deviceID,
            anchor.ecdhPublicKey, anchor.mlkemPublicKey,
        ])
        let digest = SHA256.hash(data: payload).hex.uppercased()
        return stride(from: 0, to: digest.count, by: 4).map { index in
            let start = digest.index(digest.startIndex, offsetBy: index)
            let end = digest.index(start, offsetBy: 4)
            return String(digest[start..<end])
        }.joined(separator: "-")
    }

    static func createContext(anchor: DeviceApprovalAnchor, sessionID: String) throws -> String {
        let anchor = try canonicalize(anchor)
        return try String(decoding: jsonArray([
            "thunderbolt-device-approval-sas-v1", "approve-account-key", "p256+mlkem768", "decimal-2",
            anchor.userID, anchor.deviceID, anchor.ecdhPublicKey, anchor.mlkemPublicKey, sessionID,
        ]), as: UTF8.self)
    }

    static func commitment(context: String, reveal: String) throws -> String {
        try hashHex(jsonArray(["commit", context, reveal]))
    }

    static func code(context: String, challengerDeviceID: String, challenge: String, reveal: String) throws -> String {
        let digest = SHA256.hash(data: try jsonArray(["sas", context, challengerDeviceID, challenge, reveal]))
        let remainder = digest.reduce(0) { ($0 * 256 + Int($1)) % 100 }
        return String(format: "%02d", remainder)
    }

    static func verifiedCode(anchor: DeviceApprovalAnchor, attempt: DeviceApprovalConfirmation, challengerDeviceID: String) throws -> String? {
        let context = try createContext(anchor: anchor, sessionID: attempt.sessionID)
        guard constantTimeEqual(try commitment(context: context, reveal: attempt.reveal), attempt.commitment) else { return nil }
        return try code(context: context, challengerDeviceID: challengerDeviceID, challenge: attempt.challenge, reveal: attempt.reveal)
    }

    static func matches(_ attempt: DeviceApprovalConfirmation, anchor: DeviceApprovalAnchor, challengerDeviceID: String) throws -> Bool {
        guard attempt.code.utf8.count == 2, attempt.code.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              let expected = try verifiedCode(anchor: anchor, attempt: attempt, challengerDeviceID: challengerDeviceID) else { return false }
        return constantTimeEqual(expected, attempt.code)
    }

    static func options(for code: String) throws -> [String] {
        guard code.utf8.count == 2, code.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { throw CryptoFailure.malformedValue }
        var values: Set<String> = [code]
        while values.count < 6 { values.insert(String(format: "%02d", try randomBelow(100))) }
        var shuffled = Array(values)
        for index in stride(from: shuffled.count - 1, through: 1, by: -1) {
            let swap = try randomBelow(index + 1)
            shuffled.swapAt(index, swap)
        }
        return shuffled
    }

    private static func randomBelow(_ bound: Int) throws -> Int {
        let limit = UInt64(UInt32.max) + 1
        let cutoff = limit - limit % UInt64(bound)
        while true {
            let bytes = try ThunderboltCrypto.randomBytes(count: 4)
            let value = bytes.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            if value < cutoff { return Int(value % UInt64(bound)) }
        }
    }

    private static func jsonArray(_ values: [String]) throws -> Data {
        let encoded = values.map(jsonString).joined(separator: ",")
        return Data("[\(encoded)]".utf8)
    }

    /// Mirrors JavaScript's JSON.stringify string escaping; Foundation also escapes `/`,
    /// which would change the commit/SAS bytes for base64 public keys.
    private static func jsonString(_ value: String) -> String {
        var result = "\""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x22: result += "\\\""
            case 0x5c: result += "\\\\"
            case 0x08: result += "\\b"
            case 0x09: result += "\\t"
            case 0x0a: result += "\\n"
            case 0x0c: result += "\\f"
            case 0x0d: result += "\\r"
            case 0x00...0x1f: result += String(format: "\\u%04x", scalar.value)
            default: result.unicodeScalars.append(scalar)
            }
        }
        result += "\""
        return result
    }

    private static func hashHex(_ data: Data) -> String { SHA256.hash(data: data).hex }

    private static func constantTimeEqual(_ left: String, _ right: String) -> Bool {
        let lhs = Array(left.utf8)
        let rhs = Array(right.utf8)
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }
}

private extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

private extension Digest {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
