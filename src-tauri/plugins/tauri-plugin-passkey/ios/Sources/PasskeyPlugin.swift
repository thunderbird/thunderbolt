// iOS passkey plugin for Tauri. Runs the platform-passkey ceremony via
// ASAuthorizationController (UIKit anchor) and resolves the base64url fields the
// webview assembles into a WebAuthn response JSON. Mirrors the macOS swift-lib
// handler; kept separate because it goes through the Tauri mobile Invoke bridge
// and uses UIWindow rather than NSWindow.

import AuthenticationServices
import SwiftRs
import Tauri
import UIKit
import WebKit

// --- Invoke argument shapes (match src/models.rs, camelCase) ---
struct RegisterArgs: Decodable {
    let rpId: String
    let challenge: [UInt8]
    let userId: [UInt8]
    let userName: String
    let userDisplayName: String
    let prfSalt: [UInt8]?
}

struct AuthenticateArgs: Decodable {
    let rpId: String
    let challenge: [UInt8]
    let allowCredentials: [[UInt8]]?
    let prfSalt: [UInt8]?
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
    private var handler: IOSPasskeyHandler?

    @objc public func isAvailable(_ invoke: Invoke) throws {
        if #available(iOS 16.0, *) {
            invoke.resolve(["available": true])
        } else {
            invoke.resolve(["available": false])
        }
    }

    @objc public func register(_ invoke: Invoke) throws {
        guard #available(iOS 16.0, *) else { invoke.reject("passkeys unavailable"); return }
        let args = try invoke.parseArgs(RegisterArgs.self)
        let h = IOSPasskeyHandler(anchor: bestWindow())
        self.handler = h
        Task {
            do {
                let credential = try await h.beginRegistration(
                    domain: args.rpId,
                    challenge: Data(args.challenge),
                    username: args.userName,
                    userID: Data(args.userId),
                    salt: (args.prfSalt?.isEmpty == false) ? Data(args.prfSalt!) : nil
                )
                let id = credential.credentialID.base64URLEncodedString()
                invoke.resolve([
                    "id": id,
                    "rawId": id,
                    "clientDataJson": credential.rawClientDataJSON.base64URLEncodedString(),
                    "attestationObject": credential.rawAttestationObject?.base64URLEncodedString() ?? "",
                    "prfOutput": prfString(credential.prf?.first),
                ])
            } catch {
                self.rejectCeremony(invoke, error)
            }
        }
    }

    @objc public func authenticate(_ invoke: Invoke) throws {
        guard #available(iOS 16.0, *) else { invoke.reject("passkeys unavailable"); return }
        let args = try invoke.parseArgs(AuthenticateArgs.self)
        let h = IOSPasskeyHandler(anchor: bestWindow())
        self.handler = h
        Task {
            do {
                let assertion = try await h.beginLogin(
                    domain: args.rpId,
                    challenge: Data(args.challenge),
                    allowCredentials: (args.allowCredentials ?? []).map { Data($0) },
                    salt: (args.prfSalt?.isEmpty == false) ? Data(args.prfSalt!) : nil
                )
                let id = assertion.credentialID.base64URLEncodedString()
                invoke.resolve([
                    "id": id,
                    "rawId": id,
                    "clientDataJson": assertion.rawClientDataJSON.base64URLEncodedString(),
                    "authenticatorData": assertion.rawAuthenticatorData.base64URLEncodedString(),
                    "signature": assertion.signature.base64URLEncodedString(),
                    "userHandle": assertion.userID.base64URLEncodedString(),
                    "prfOutput": prfString(assertion.prf?.first),
                ])
            } catch {
                self.rejectCeremony(invoke, error)
            }
        }
    }

    private func rejectCeremony(_ invoke: Invoke, _ error: Error) {
        if let asError = error as? ASAuthorizationError, asError.code == .canceled {
            invoke.reject("cancelled")
        } else {
            invoke.reject(error.localizedDescription)
        }
    }

    private func prfString(_ output: Data?) -> String {
        output?.base64URLEncodedString() ?? ""
    }

    private func bestWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }
    }
}

@available(iOS 16.0, *)
final class IOSPasskeyHandler: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var registrationContinuation: CheckedContinuation<ASAuthorizationPlatformPublicKeyCredentialRegistration, Error>?
    private var loginContinuation: CheckedContinuation<ASAuthorizationPlatformPublicKeyCredentialAssertion, Error>?
    private let anchor: UIWindow?

    init(anchor: UIWindow?) { self.anchor = anchor }

    func beginRegistration(domain: String, challenge: Data, username: String, userID: Data, salt: Data?) async throws
        -> ASAuthorizationPlatformPublicKeyCredentialRegistration
    {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: domain)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: username, userID: userID)
        if #available(iOS 18.0, *), let salt = salt {
            let values = ASAuthorizationPublicKeyCredentialPRFRegistrationInput.InputValues(saltInput1: salt)
            request.prf = ASAuthorizationPublicKeyCredentialPRFRegistrationInput.inputValues(values)
        }
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { continuation in
            self.registrationContinuation = continuation
            DispatchQueue.main.async { controller.performRequests() }
        }
    }

    func beginLogin(domain: String, challenge: Data, allowCredentials: [Data], salt: Data?) async throws
        -> ASAuthorizationPlatformPublicKeyCredentialAssertion
    {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: domain)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        if !allowCredentials.isEmpty {
            request.allowedCredentials = allowCredentials.map {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0)
            }
        }
        if #available(iOS 18.0, *), let salt = salt {
            let values = ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(saltInput1: salt)
            request.prf = ASAuthorizationPublicKeyCredentialPRFAssertionInput.inputValues(values)
        }
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        return try await withCheckedThrowingContinuation { continuation in
            self.loginContinuation = continuation
            DispatchQueue.main.async { controller.performRequests() }
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        anchor ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization auth: ASAuthorization) {
        if let registration = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            registrationContinuation?.resume(returning: registration)
            registrationContinuation = nil
        } else if let assertion = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            loginContinuation?.resume(returning: assertion)
            loginContinuation = nil
        } else {
            let error = NSError(domain: "PasskeyPlugin", code: -3,
                                userInfo: [NSLocalizedDescriptionKey: "Unsupported credential type."])
            registrationContinuation?.resume(throwing: error)
            loginContinuation?.resume(throwing: error)
            registrationContinuation = nil
            loginContinuation = nil
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        registrationContinuation?.resume(throwing: error)
        loginContinuation?.resume(throwing: error)
        registrationContinuation = nil
        loginContinuation = nil
    }
}

@_cdecl("init_plugin_passkey")
func initPlugin() -> Plugin {
    return PasskeyPlugin()
}
