// Adapted from yminghua/tauri-plugin-macos-passkey (MIT OR Apache-2.0).
// C-callable entry points bridged into Rust via swift-rs (see src/desktop.rs).
// Every field, PRF output included, is base64url so Rust forwards plain strings.

import Foundation
import AuthenticationServices
import AppKit
import CryptoKit
import SwiftRs

/// Ceremony outcome reported to Rust; must match the `STATUS_*` constants in src/desktop.rs.
enum CeremonyStatus: Int32 {
    case ok = 0
    case cancelled = 1
    case failed = 2
}

public typealias PasskeyResultCallback = @Sendable @convention(c) (UnsafeMutableRawPointer?, Int32, UnsafePointer<CChar>?, UInt64) -> Void

@objcMembers
public class RegistrationResultObject: NSObject {
    public let id: SRString
    public let rawId: SRString
    public let clientDataJSON: SRString
    public let attestationObject: SRString
    public let prfOutput: SRString

    @available(macOS 13.0, *)
    public init(from credential: ASAuthorizationPlatformPublicKeyCredentialRegistration) {
        let idEncoded = credential.credentialID.base64URLEncodedString()
        self.id = SRString(idEncoded)
        self.rawId = SRString(idEncoded)
        self.clientDataJSON = SRString(credential.rawClientDataJSON.base64URLEncodedString())
        self.attestationObject = SRString(credential.rawAttestationObject?.base64URLEncodedString() ?? "")
        self.prfOutput = SRString(prfBase64URL(of: credential))
    }
}

@objcMembers
public class LoginResultObject: NSObject {
    public let id: SRString
    public let rawId: SRString
    public let clientDataJSON: SRString
    public let authenticatorData: SRString
    public let signature: SRString
    public let userHandle: SRString
    public let prfOutput: SRString

    @available(macOS 13.0, *)
    public init(from assertion: ASAuthorizationPlatformPublicKeyCredentialAssertion) {
        let idEncoded = assertion.credentialID.base64URLEncodedString()
        self.id = SRString(idEncoded)
        self.rawId = SRString(idEncoded)
        self.clientDataJSON = SRString(assertion.rawClientDataJSON.base64URLEncodedString())
        self.authenticatorData = SRString(assertion.rawAuthenticatorData.base64URLEncodedString())
        self.signature = SRString(assertion.signature.base64URLEncodedString())
        self.userHandle = SRString(assertion.userID.base64URLEncodedString())
        self.prfOutput = SRString(prfBase64URL(of: assertion))
    }
}

/// The PRF output arrives as a CryptoKit key; empty when the provider has none.
private func prfString(_ key: SymmetricKey?) -> String {
    key?.withUnsafeBytes { Data($0) }.base64URLEncodedString() ?? ""
}

// PRF needs macOS 15; before it a passkey signs in but has no PRF output.
@available(macOS 13.0, *)
private func prfBase64URL(of credential: ASAuthorizationPlatformPublicKeyCredentialRegistration) -> String {
    guard #available(macOS 15.0, *) else { return "" }
    return prfString(credential.prf?.first)
}

@available(macOS 13.0, *)
private func prfBase64URL(of assertion: ASAuthorizationPlatformPublicKeyCredentialAssertion) -> String {
    guard #available(macOS 15.0, *) else { return "" }
    return prfString(assertion.prf?.first)
}

/// Nil for an empty salt, which leaves the PRF extension out.
private func saltData(_ salt: SRData) -> Data? {
    let bytes = salt.toArray()
    return bytes.isEmpty ? nil : Data(bytes)
}

/// Unpack the credential ids Rust sends, each prefixed with a two-byte big-endian length.
func unpackCredentialIDs(_ bytes: [UInt8]) -> [Data] {
    var ids: [Data] = []
    var index = 0
    while index + 2 <= bytes.count {
        let length = Int(bytes[index]) << 8 | Int(bytes[index + 1])
        index += 2
        precondition(index + length <= bytes.count, "malformed credential id list")
        ids.append(Data(bytes[index..<index + length]))
        index += length
    }
    return ids
}

/// Report a ceremony to Rust: the result object (+1 retained, adopted by Rust) on
/// success, or a status and the OS error message.
private func report(_ result: Result<NSObject, Error>, context: UInt64, callback: PasskeyResultCallback) {
    switch result {
    case .success(let object):
        callback(Unmanaged.passRetained(object).toOpaque(), CeremonyStatus.ok.rawValue, nil, context)
    case .failure(let error as ASAuthorizationError) where error.code == .canceled:
        callback(nil, CeremonyStatus.cancelled.rawValue, nil, context)
    case .failure(let error):
        error.localizedDescription.withCString { callback(nil, CeremonyStatus.failed.rawValue, $0, context) }
    }
}

/// Report a ceremony on a macOS without platform passkeys; the app doesn't offer them there.
private func reportUnsupported(context: UInt64, callback: PasskeyResultCallback) {
    "passkeys need macOS 13".withCString { callback(nil, CeremonyStatus.failed.rawValue, $0, context) }
}

// The SRString/SRData arguments are borrowed from Rust, so everything is copied out
// before these return (the ceremony itself runs on the main queue).
@_cdecl("begin_passkey_registration")
public func beginPasskeyRegistration(
    windowPtr: UnsafeMutableRawPointer,
    domain: SRString,
    challenge: SRData,
    username: SRString,
    userID: SRData,
    excludeCredentials: SRData,
    salt: SRData,
    context: UInt64,
    callback: PasskeyResultCallback
) {
    guard #available(macOS 13.0, *) else { return reportUnsupported(context: context, callback: callback) }
    ApplePasskeyHandler(windowPtr: windowPtr).beginRegistration(
        domain: domain.toString(), challenge: Data(challenge.toArray()), username: username.toString(),
        userID: Data(userID.toArray()), excludeCredentials: unpackCredentialIDs(excludeCredentials.toArray()),
        salt: saltData(salt)
    ) { result in
        report(result.map { RegistrationResultObject(from: $0) }, context: context, callback: callback)
    }
}

@_cdecl("begin_passkey_login")
public func beginPasskeyLogin(
    windowPtr: UnsafeMutableRawPointer,
    domain: SRString,
    challenge: SRData,
    allowCredentials: SRData,
    salt: SRData,
    context: UInt64,
    callback: PasskeyResultCallback
) {
    guard #available(macOS 13.0, *) else { return reportUnsupported(context: context, callback: callback) }
    ApplePasskeyHandler(windowPtr: windowPtr).beginLogin(
        domain: domain.toString(), challenge: Data(challenge.toArray()),
        allowCredentials: unpackCredentialIDs(allowCredentials.toArray()), salt: saltData(salt)
    ) { result in
        report(result.map { LoginResultObject(from: $0) }, context: context, callback: callback)
    }
}
