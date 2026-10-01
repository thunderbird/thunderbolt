// Adapted from yminghua/tauri-plugin-macos-passkey (MIT OR Apache-2.0).
// Runs the macOS platform-passkey ceremony via ASAuthorizationController.

import Foundation
import AuthenticationServices
import AppKit
import OSLog

public final class ApplePasskeyHandler: NSObject {
    private var registrationContinuation: CheckedContinuation<ASAuthorizationPlatformPublicKeyCredentialRegistration, Error>?
    private var loginContinuation: CheckedContinuation<ASAuthorizationPlatformPublicKeyCredentialAssertion, Error>?

    private let providedWindow: NSWindow?
    private let logger = Logger(subsystem: "io.thunderbolt.passkey", category: "ApplePasskeyHandler")

    public init(windowPtr: UnsafeMutableRawPointer?) {
        if let ptr = windowPtr {
            self.providedWindow = Unmanaged<NSWindow>.fromOpaque(ptr).takeUnretainedValue()
        } else {
            self.providedWindow = nil
        }
    }

    @available(macOS 15.0, *)
    public func beginRegistration(domain: String, challenge: Data, username: String, userID: Data, salt: Data?) async throws
        -> ASAuthorizationPlatformPublicKeyCredentialRegistration
    {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: domain)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: username, userID: userID)
        if let salt = salt {
            let values = ASAuthorizationPublicKeyCredentialPRFRegistrationInput.InputValues(saltInput1: salt)
            request.prf = ASAuthorizationPublicKeyCredentialPRFRegistrationInput.inputValues(values)
        }

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { continuation in
            self.registrationContinuation = continuation
            controller.performRequests()
        }
    }

    @available(macOS 15.0, *)
    public func beginLogin(domain: String, challenge: Data, salt: Data?) async throws
        -> ASAuthorizationPlatformPublicKeyCredentialAssertion
    {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: domain)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        // TODO(passkey): thread `allowCredentials` → request.allowedCredentials for
        // non-discoverable sign-in. Discoverable (usernameless) works without it.
        if let salt = salt {
            let values = ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: salt)
            request.prf = ASAuthorizationPublicKeyCredentialPRFAssertionInput.inputValues(values)
        }

        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { continuation in
            self.loginContinuation = continuation
            controller.performRequests()
        }
    }
}

extension ApplePasskeyHandler: ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        return providedWindow ?? NSApplication.shared.windows.first!
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization auth: ASAuthorization) {
        if let registration = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            registrationContinuation?.resume(returning: registration)
            registrationContinuation = nil
        } else if let assertion = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            loginContinuation?.resume(returning: assertion)
            loginContinuation = nil
        } else {
            let error = NSError(domain: "ApplePasskeyHandler", code: -3,
                                userInfo: [NSLocalizedDescriptionKey: "Unsupported credential type."])
            registrationContinuation?.resume(throwing: error)
            loginContinuation?.resume(throwing: error)
            registrationContinuation = nil
            loginContinuation = nil
        }
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        registrationContinuation?.resume(throwing: error)
        loginContinuation?.resume(throwing: error)
        registrationContinuation = nil
        loginContinuation = nil
    }
}

public extension Data {
    /// Base64URL (no padding) — the encoding WebAuthn response fields use.
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
