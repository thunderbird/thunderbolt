/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct SignInView: View {
    @Bindable var model: AppModel
    @State private var settingsPresented = false

    private var showsBackButton: Bool {
        model.challengeSent || model.isWaitingForApproval
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(spacing: 18) {
                    Spacer(minLength: 20)
                    if model.isWaitingForApproval {
                        waitlistForm
                    } else if model.challengeSent {
                        codeForm
                    } else {
                        emailForm
                    }
                    if let error = model.authError, !error.isEmpty {
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                            .accessibilityIdentifier("signInError")
                    }
                    Spacer(minLength: 20)
                }
                .frame(maxWidth: 440)
                .frame(maxWidth: .infinity)
                .frame(minHeight: geometry.size.height)
                .padding(.horizontal, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(TBPalette.background)
        }
        .background(TBPalette.background.ignoresSafeArea())
        .overlay(alignment: .topLeading) {
            if showsBackButton {
                Button(action: model.backToEmail) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(TBPalette.foreground)
                        .frame(width: 48, height: 48)
                        .background(TBPalette.secondary.opacity(0.8), in: Circle())
                }
                .accessibilityLabel("Back")
                .accessibilityIdentifier("signInBack")
                .padding(.leading, 12)
                .padding(.top, 8)
            }
        }
        .sheet(isPresented: $settingsPresented) {
            SettingsView(model: model)
        }
    }

    private var emailForm: some View {
        VStack(spacing: 16) {
            Text("Sign In")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)
                .padding(.bottom, 4)

            if model.isLoadingAuthConfiguration || (model.authConfiguration == nil && model.authError == nil) {
                ProgressView(nativeString( "Connecting…"))
            } else if model.authConfiguration == nil {
                Button("Try again") { Task { await model.loadAuthConfiguration() } }
                    .accessibilityIdentifier("retryAuthConfiguration")
            }

            if model.authConfiguration?.supportsEmailOTP == true {
            HStack(spacing: 12) {
                Image(systemName: "envelope")
                    .font(.system(size: 20))
                    .foregroundStyle(TBPalette.muted)
                    .accessibilityHidden(true)
                TextField(
                    "Email address",
                    text: $model.email,
                    prompt: Text("Email address").foregroundStyle(TBPalette.muted)
                )
                    .keyboardType(.emailAddress)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .onSubmit(sendCode)
                    .accessibilityIdentifier("signInEmail")
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 48)
            .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border, lineWidth: 1))

            Button(action: sendCode) {
                HStack(spacing: 10) {
                    if model.isAuthenticating { ProgressView().tint(TBPalette.surface) }
                    Text(model.isAuthenticating
                         ? nativeString( "Sending…")
                         : nativeString( "Send Magic Link"))
                        .font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: 48)
            }
            .buttonStyle(TBPrimaryButtonStyle())
            .disabled(model.isAuthenticating || model.email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("sendCode")

            }

            if model.authConfiguration?.usesSSO == true {
                Button { Task { await model.signInWithSSO() } } label: {
                    HStack(spacing: 10) {
                        if model.isAuthenticating { ProgressView().tint(TBPalette.surface) }
                        Text("Continue with SSO").font(.body.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity, minHeight: 48)
                }
                .buttonStyle(TBPrimaryButtonStyle())
                .disabled(model.isAuthenticating)
                .accessibilityIdentifier("signInSSO")
            }
            if model.authConfiguration?.supportsPasskey == true {
                Button { Task { await model.signInWithPasskey() } } label: {
                    Label("Sign in with a passkey", systemImage: "person.badge.key")
                        .frame(maxWidth: .infinity, minHeight: 48)
                }
                .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
                .disabled(model.isAuthenticating)
                .accessibilityIdentifier("signInPasskey")
            }
            if model.authConfiguration?.supportsAnonymousSignIn == true {
                Button("Continue as guest") { Task { await model.signInAnonymously() } }
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .disabled(model.isAuthenticating)
                    .accessibilityIdentifier("signInAnonymously")
            }

            Button("Change server") {
                settingsPresented = true
            }
            .font(.body.weight(.medium))
            .frame(maxWidth: .infinity)
            .frame(minHeight: 48)
            .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border, lineWidth: 1))
            .accessibilityIdentifier("openSettings")

            Text(model.serverURL == ServerAddress.cloud ? nativeString( "Thunderbolt Cloud") : model.serverURL)
                .font(.footnote)
                .foregroundStyle(TBPalette.muted)
                .lineLimit(1)
                .truncationMode(.middle)
                .accessibilityIdentifier("currentServerLabel")
        }
    }

    private var codeForm: some View {
        VStack(spacing: 16) {
            Image(systemName: "envelope.badge")
                .font(.system(size: 44))
                .foregroundStyle(
                    LinearGradient(colors: [TBPalette.brandAmber, TBPalette.brand], startPoint: .leading, endPoint: .trailing)
                )
                .padding(.bottom, 2)
                .accessibilityHidden(true)

            Text("Check your email")
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text("We sent a code to \(model.email).")
                .font(.subheadline)
                .foregroundStyle(TBPalette.muted)
                .multilineTextAlignment(.center)
            Text("Or enter the 8-digit code")
                .font(.subheadline)
                .foregroundStyle(TBPalette.muted)
                .padding(.top, 4)

            codeEntry

            Button(action: verifyCode) {
                HStack(spacing: 10) {
                    if model.isAuthenticating { ProgressView().tint(TBPalette.surface) }
                    Text(model.isAuthenticating
                         ? nativeString( "Verifying…")
                         : nativeString( "Continue"))
                        .font(.body.weight(.semibold))
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: 48)
            }
            .buttonStyle(TBPrimaryButtonStyle())
            .disabled(model.isAuthenticating || model.otp.filter(\.isNumber).count < 8)
            .accessibilityIdentifier("verifyCode")

            Button("Resend Email", action: sendCode)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(TBPalette.muted)
                .disabled(model.isAuthenticating)

            Text("Or click the magic link in your email")
                .font(.footnote)
                .foregroundStyle(TBPalette.muted)
                .multilineTextAlignment(.center)
                .padding(.top, 2)

            Button("Cancel", action: model.backToEmail)
                .font(.body.weight(.medium))
                .frame(maxWidth: .infinity)
                .frame(minHeight: 48)
                .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border, lineWidth: 1))
        }
        .frame(maxWidth: 440)
        .padding(.top, 16)
    }

    private var codeEntry: some View {
        ZStack {
            HStack(spacing: 7) {
                ForEach(0..<8, id: \.self) { index in
                    let digits = Array(model.otp.filter(\.isNumber))
                    Text(index < digits.count ? String(digits[index]) : "")
                        .font(.system(.title2, design: .monospaced, weight: .medium))
                        .foregroundStyle(TBPalette.foreground)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(TBPalette.border, lineWidth: 1))
                }
            }
            .accessibilityHidden(true)
            TextField("", text: $model.otp)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .textInputAutocapitalization(.never)
                .foregroundStyle(.clear)
                .tint(.clear)
                .accessibilityLabel("8-digit code")
                .accessibilityIdentifier("signInCode")
        }
    }

    private var waitlistForm: some View {
        VStack(spacing: 16) {
            Image(systemName: "envelope.badge")
                .font(.system(size: 44))
                .foregroundStyle(
                    LinearGradient(colors: [TBPalette.brandAmber, TBPalette.brand], startPoint: .leading, endPoint: .trailing)
                )
                .accessibilityHidden(true)
            Text("You're on the list")
                .font(.title3.weight(.semibold))
            Text("We'll email you when your Thunderbolt Cloud account is ready.")
                .font(.subheadline)
                .foregroundStyle(TBPalette.muted)
                .multilineTextAlignment(.center)
            Text(model.serverURL == ServerAddress.cloud ? nativeString( "Thunderbolt Cloud") : model.serverURL)
                .font(.footnote)
                .foregroundStyle(TBPalette.muted)
                .lineLimit(1)
                .truncationMode(.middle)
                .accessibilityIdentifier("currentServerLabel")
        }
        .frame(maxWidth: 440)
    }

    private func sendCode() {
        Task { await model.sendCode() }
    }

    private func verifyCode() {
        Task { await model.verifyCode() }
    }
}
