/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import JavaScriptCore

private final class CryptoBundleMarker {}

/// Calls the repository-pinned Noble implementation shipped as a local app resource.
/// JavaScriptCore is used only for ML-KEM-768, BIP-39, and Noble's scalar reduction;
/// entropy is always supplied by SecRandomCopyBytes from Swift.
final class NobleCryptoBridge: @unchecked Sendable {
    static let shared = NobleCryptoBridge()

    private let lock = NSRecursiveLock()
    private let context: JSContext
    private var scriptError: String?

    private init() {
        context = JSContext()!
        context.exceptionHandler = { [weak self] _, exception in
            self?.scriptError = exception?.toString()
        }
        let bundle = Bundle(for: CryptoBundleMarker.self)
        let scriptURL = bundle.url(forResource: "noble-bridge", withExtension: "js")
            ?? bundle.url(forResource: "noble-bridge", withExtension: "js", subdirectory: "Crypto")
        guard let scriptURL,
              let source = try? String(contentsOf: scriptURL, encoding: .utf8) else {
            scriptError = "Missing local cryptography module"
            return
        }
        context.evaluateScript(source)
    }

    func invoke(_ method: String, _ arguments: [Any]) throws -> String {
        lock.lock()
        defer { lock.unlock() }
        scriptError = nil
        guard let api = context.objectForKeyedSubscript("__thunderboltNoble"),
              let result = api.invokeMethod(method, withArguments: arguments),
              !result.isUndefined, !result.isNull else {
            throw CryptoFailure.bridge(scriptError ?? "Cryptography module call failed")
        }
        if let scriptError {
            throw CryptoFailure.bridge(scriptError)
        }
        guard let string = result.toString() else { throw CryptoFailure.bridge("Invalid cryptography module result") }
        return string
    }
}
