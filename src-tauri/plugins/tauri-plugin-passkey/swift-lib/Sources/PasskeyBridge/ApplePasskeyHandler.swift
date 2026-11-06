// Adapted from yminghua/tauri-plugin-macos-passkey (MIT OR Apache-2.0).
// Runs the macOS platform-passkey ceremony via ASAuthorizationController.
// Completion handlers rather than async/await: Swift concurrency's runtime only
// ships with macOS 12+, and this library links into an app that supports older.

import Foundation
import AuthenticationServices
import AppKit

/// One handler per ceremony. It keeps itself alive until the delegate reports,
/// since the controller holds its delegate weakly.
@available(macOS 13.0, *)
public final class ApplePasskeyHandler: NSObject {
    private let window: NSWindow
    private var completion: ((Result<ASAuthorization, Error>) -> Void)?
    private var keepAlive: ApplePasskeyHandler?

    public init(windowPtr: UnsafeMutableRawPointer) {
        self.window = Unmanaged<NSWindow>.fromOpaque(windowPtr).takeUnretainedValue()
    }

    public func beginRegistration(
        domain: String, challenge: Data, username: String, userID: Data, excludeCredentials: [Data], salt: Data?,
        completion: @escaping (Result<ASAuthorizationPlatformPublicKeyCredentialRegistration, Error>) -> Void
    ) {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: domain)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: username, userID: userID)
        if #available(macOS 14.4, *) {
            request.excludedCredentials = excludeCredentials.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }
        // PRF needs macOS 15; older versions still create a passkey that signs in.
        if let salt, #available(macOS 15.0, *) {
            let values = ASAuthorizationPublicKeyCredentialPRFRegistrationInput.InputValues(saltInput1: salt)
            request.prf = .inputValues(values)
        }
        perform(request) { completion($0.flatMap(credential(of:))) }
    }

    public func beginLogin(
        domain: String, challenge: Data, allowCredentials: [Data], salt: Data?,
        completion: @escaping (Result<ASAuthorizationPlatformPublicKeyCredentialAssertion, Error>) -> Void
    ) {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: domain)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        // Empty for sign-in (any passkey for the RP); one id for sync unlock.
        if !allowCredentials.isEmpty {
            request.allowedCredentials = allowCredentials.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }
        if let salt, #available(macOS 15.0, *) {
            let values = ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: salt)
            request.prf = .inputValues(values)
        }
        perform(request) { completion($0.flatMap(credential(of:))) }
    }

    private func perform(_ request: ASAuthorizationRequest, completion: @escaping (Result<ASAuthorization, Error>) -> Void) {
        self.completion = completion
        keepAlive = self
        DispatchQueue.main.async {
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private func finish(_ result: Result<ASAuthorization, Error>) {
        completion?(result)
        completion = nil
        keepAlive = nil
    }
}

/// The credential a ceremony returned, as the type its request asked for.
func credential<T>(of authorization: ASAuthorization) -> Result<T, Error> {
    guard let credential = authorization.credential as? T else {
        return .failure(NSError(domain: "PasskeyBridge", code: 0, userInfo: [
            NSLocalizedDescriptionKey: "Unexpected credential type \(type(of: authorization.credential)).",
        ]))
    }
    return .success(credential)
}

@available(macOS 13.0, *)
extension ApplePasskeyHandler: ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        window
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization auth: ASAuthorization) {
        finish(.success(auth))
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        finish(.failure(error))
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
