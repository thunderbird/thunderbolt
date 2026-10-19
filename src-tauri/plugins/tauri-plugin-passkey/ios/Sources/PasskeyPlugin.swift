// iOS passkey plugin for Tauri. Runs the platform-passkey ceremony via
// ASAuthorizationController (UIKit anchor) and resolves the base64url fields the
// webview assembles into a WebAuthn response JSON. Mirrors the macOS swift-lib
// handler; kept separate because it goes through the Tauri mobile Invoke bridge
// and uses UIWindow rather than NSWindow.

import AuthenticationServices
import CryptoKit
import Tauri
import UIKit

// --- Invoke argument shapes (match src/models.rs, camelCase) ---
struct RegisterArgs: Decodable {
    let rpId: String
    let challenge: [UInt8]
    let userId: [UInt8]
    let userName: String
    let excludeCredentials: [[UInt8]]?
    let prfSalt: [UInt8]?
}

struct AuthenticateArgs: Decodable {
    let rpId: String
    let challenge: [UInt8]
    let allowCredentials: [[UInt8]]?
    let prfSalt: [UInt8]?
}

/// The reject code for a dismissed sheet; src/mobile.rs maps it to `Error::Cancelled`.
private let cancelledCode = "cancelled"

/// Nil for an empty salt, which leaves the PRF extension out.
private func saltData(_ bytes: [UInt8]?) -> Data? {
    guard let bytes, !bytes.isEmpty else { return nil }
    return Data(bytes)
}

/// iOS hands the PRF output back as a CryptoKit key; the webview wants base64url.
private func prfString(_ key: SymmetricKey?) -> String {
    key?.withUnsafeBytes { Data($0) }.base64URLEncodedString() ?? ""
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

class PasskeyPlugin: Plugin {
    @objc public func register(_ invoke: Invoke) throws {
        guard #available(iOS 16.0, *) else { invoke.reject("passkeys need iOS 16"); return }
        let args = try invoke.parseArgs(RegisterArgs.self)
        Task {
            do {
                let credential = try await IOSPasskeyHandler().beginRegistration(
                    domain: args.rpId,
                    challenge: Data(args.challenge),
                    username: args.userName,
                    userID: Data(args.userId),
                    excludeCredentials: (args.excludeCredentials ?? []).map { Data($0) },
                    salt: saltData(args.prfSalt)
                )
                let id = credential.credentialID.base64URLEncodedString()
                invoke.resolve([
                    "id": id,
                    "rawId": id,
                    "clientDataJson": credential.rawClientDataJSON.base64URLEncodedString(),
                    "attestationObject": credential.rawAttestationObject?.base64URLEncodedString() ?? "",
                    "prfOutput": prfOutput(of: credential),
                ])
            } catch {
                rejectCeremony(invoke, error)
            }
        }
    }

    @objc public func authenticate(_ invoke: Invoke) throws {
        guard #available(iOS 16.0, *) else { invoke.reject("passkeys need iOS 16"); return }
        let args = try invoke.parseArgs(AuthenticateArgs.self)
        Task {
            do {
                let assertion = try await IOSPasskeyHandler().beginLogin(
                    domain: args.rpId,
                    challenge: Data(args.challenge),
                    allowCredentials: (args.allowCredentials ?? []).map { Data($0) },
                    salt: saltData(args.prfSalt)
                )
                let id = assertion.credentialID.base64URLEncodedString()
                invoke.resolve([
                    "id": id,
                    "rawId": id,
                    "clientDataJson": assertion.rawClientDataJSON.base64URLEncodedString(),
                    "authenticatorData": assertion.rawAuthenticatorData.base64URLEncodedString(),
                    "signature": assertion.signature.base64URLEncodedString(),
                    "userHandle": assertion.userID.base64URLEncodedString(),
                    "prfOutput": prfOutput(of: assertion),
                ])
            } catch {
                rejectCeremony(invoke, error)
            }
        }
    }
}

private func rejectCeremony(_ invoke: Invoke, _ error: Error) {
    if let asError = error as? ASAuthorizationError, asError.code == .canceled {
        invoke.reject("passkey ceremony cancelled", code: cancelledCode)
    } else {
        invoke.reject(error.localizedDescription)
    }
}

// PRF needs iOS 18; older versions still create a passkey that signs in.
@available(iOS 16.0, *)
private func prfOutput(of credential: ASAuthorizationPlatformPublicKeyCredentialRegistration) -> String {
    guard #available(iOS 18.0, *) else { return "" }
    return prfString(credential.prf?.first)
}

@available(iOS 16.0, *)
private func prfOutput(of assertion: ASAuthorizationPlatformPublicKeyCredentialAssertion) -> String {
    guard #available(iOS 18.0, *) else { return "" }
    return prfString(assertion.prf?.first)
}

/// The credential a ceremony returned, as the type its request asked for.
private func credential<T>(of authorization: ASAuthorization) throws -> T {
    guard let credential = authorization.credential as? T else {
        throw NSError(domain: "PasskeyPlugin", code: 0,
                      userInfo: [NSLocalizedDescriptionKey: "Unexpected credential type \(type(of: authorization.credential))."])
    }
    return credential
}

/// One handler per ceremony: it holds the continuation the delegate resumes.
@available(iOS 16.0, *)
final class IOSPasskeyHandler: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    func beginRegistration(
        domain: String, challenge: Data, username: String, userID: Data, excludeCredentials: [Data], salt: Data?
    ) async throws -> ASAuthorizationPlatformPublicKeyCredentialRegistration {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: domain)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: username, userID: userID)
        if #available(iOS 17.4, *) {
            request.excludedCredentials = excludeCredentials.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }
        if let salt, #available(iOS 18.0, *) {
            let values = ASAuthorizationPublicKeyCredentialPRFRegistrationInput.InputValues(saltInput1: salt)
            request.prf = .inputValues(values)
        }
        return try await credential(of: perform(request))
    }

    func beginLogin(domain: String, challenge: Data, allowCredentials: [Data], salt: Data?) async throws
        -> ASAuthorizationPlatformPublicKeyCredentialAssertion
    {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: domain)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        // Empty for sign-in (any passkey for the RP); one id for sync unlock.
        if !allowCredentials.isEmpty {
            request.allowedCredentials = allowCredentials.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }
        if let salt, #available(iOS 18.0, *) {
            let values = ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: salt)
            request.prf = .inputValues(values)
        }
        return try await credential(of: perform(request))
    }

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            DispatchQueue.main.async { controller.performRequests() }
        }
    }

    // Called on the main thread, where UIKit may be read.
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let keyWindow = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
        return keyWindow ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization auth: ASAuthorization) {
        continuation?.resume(returning: auth)
        continuation = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}

@_cdecl("init_plugin_passkey")
func initPlugin() -> Plugin {
    return PasskeyPlugin()
}
