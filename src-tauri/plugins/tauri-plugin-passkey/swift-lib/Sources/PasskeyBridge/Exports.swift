// Adapted from yminghua/tauri-plugin-macos-passkey (MIT OR Apache-2.0).
// C-callable entry points bridged into Rust via swift-rs (see src/desktop.rs).
// PRF output is base64url-encoded here so Rust can forward it as an opaque string.

import Foundation
import AuthenticationServices
import AppKit
import SwiftRs

@objcMembers
public class RegistrationResultObject: NSObject {
    public let id: SRString
    public let rawId: SRString
    public let clientDataJSON: SRString
    public let attestationObject: SRString
    public let prfOutput: SRData

    public init(from credential: ASAuthorizationPlatformPublicKeyCredentialRegistration) {
        let idEncoded = credential.credentialID.base64URLEncodedString()
        self.id = SRString(idEncoded)
        self.rawId = SRString(idEncoded)
        self.clientDataJSON = SRString(credential.rawClientDataJSON.base64URLEncodedString())
        self.attestationObject = SRString(credential.rawAttestationObject?.base64URLEncodedString() ?? "")
        if let prf = credential.prf?.first {
            let encoded = prf.withUnsafeBytes { Data($0) }.base64URLEncodedString()
            self.prfOutput = SRData([UInt8](encoded.utf8))
        } else {
            self.prfOutput = SRData()
        }
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
    public let prfOutput: SRData

    public init(from assertion: ASAuthorizationPlatformPublicKeyCredentialAssertion) {
        let idEncoded = assertion.credentialID.base64URLEncodedString()
        self.id = SRString(idEncoded)
        self.rawId = SRString(idEncoded)
        self.clientDataJSON = SRString(assertion.rawClientDataJSON.base64URLEncodedString())
        self.authenticatorData = SRString(assertion.rawAuthenticatorData.base64URLEncodedString())
        self.signature = SRString(assertion.signature.base64URLEncodedString())
        self.userHandle = SRString(assertion.userID.base64URLEncodedString())
        if let prf = assertion.prf?.first {
            let encoded = prf.withUnsafeBytes { Data($0) }.base64URLEncodedString()
            self.prfOutput = SRData([UInt8](encoded.utf8))
        } else {
            self.prfOutput = SRData()
        }
    }
}

private struct UnsafeWindowPtr: @unchecked Sendable {
    let ptr: UnsafeMutableRawPointer?
}

@_cdecl("begin_passkey_registration")
public func begin_passkey_registration(
    windowPtr: UnsafeMutableRawPointer?,
    domain: SRString,
    challenge: SRData,
    username: SRString,
    userID: SRData,
    salt: SRData,
    context: UInt64,
    callback: @Sendable @convention(c) (UnsafeMutableRawPointer?, UInt64) -> Void
) {
    guard #available(macOS 15.0, *) else { callback(nil, context); return }
    let domainString = domain.toString()
    let challengeData = Data(challenge.toArray())
    let usernameString = username.toString()
    let userIDData = Data(userID.toArray())
    let saltBytes = salt.toArray()
    let saltData: Data? = saltBytes.isEmpty ? nil : Data(saltBytes)
    let window = UnsafeWindowPtr(ptr: windowPtr)

    Task {
        let handler = ApplePasskeyHandler(windowPtr: window.ptr)
        do {
            let credential = try await handler.beginRegistration(
                domain: domainString, challenge: challengeData, username: usernameString, userID: userIDData, salt: saltData)
            let resultPtr = Unmanaged.passRetained(RegistrationResultObject(from: credential)).toOpaque()
            callback(resultPtr, context)
        } catch {
            callback(nil, context)
        }
    }
}

@_cdecl("begin_passkey_login")
public func begin_passkey_login(
    windowPtr: UnsafeMutableRawPointer?,
    domain: SRString,
    challenge: SRData,
    salt: SRData,
    context: UInt64,
    callback: @Sendable @convention(c) (UnsafeMutableRawPointer?, UInt64) -> Void
) {
    guard #available(macOS 15.0, *) else { callback(nil, context); return }
    let domainString = domain.toString()
    let challengeData = Data(challenge.toArray())
    let saltBytes = salt.toArray()
    let saltData: Data? = saltBytes.isEmpty ? nil : Data(saltBytes)
    let window = UnsafeWindowPtr(ptr: windowPtr)

    Task {
        let handler = ApplePasskeyHandler(windowPtr: window.ptr)
        do {
            let assertion = try await handler.beginLogin(domain: domainString, challenge: challengeData, salt: saltData)
            let resultPtr = Unmanaged.passRetained(LoginResultObject(from: assertion)).toOpaque()
            callback(resultPtr, context)
        } catch {
            callback(nil, context)
        }
    }
}
