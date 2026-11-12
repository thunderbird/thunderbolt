/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct SecuritySettingsView: View {
    @Bindable var model: AppModel
    @State private var isAccountDeletionPresented = false
    @State private var passkeys: [NativePasskeyRecord] = []
    @State private var passkeyToRemove: NativePasskeyRecord?
    @State private var isPasskeyRemovalPresented = false
    @State private var isPasskeyActionRunning = false
    @State private var passkeyMessage: String?
    @State private var passkeyError: String?

    var body: some View {
        TBSettingsPage(nativeString("Security")) {
            TBSettingsSection(nativeString("Recovery phrase"), footer: nativeString("Changing your phrase rotates the account encryption key. Your synced conversations remain encrypted and available on trusted devices.")) {
                NavigationLink {
                    RecoveryPhraseChangeFlow(model: model)
                } label: {
                    Label("Change recovery phrase", systemImage: "key.horizontal")
                }
                .accessibilityIdentifier("changeRecoveryPhrase")
            }

            TBSettingsSection(nativeString("Passkey"), footer: nativeString("A passkey can unlock encrypted sync on a new device. Removing it rotates the account encryption key before deleting the sign-in credential.")) {
                if passkeys.isEmpty {
                    Button {
                        performPasskeyAction {
                            try await model.registerPasskeyForSync()
                            passkeys = try await model.loadPasskeys()
                            passkeyMessage = nativeString( "Passkey added for encrypted sync.")
                        }
                    } label: {
                        HStack {
                            Label("Add passkey for sync", systemImage: "person.badge.key")
                            Spacer()
                            if isPasskeyActionRunning { ProgressView() }
                        }
                    }
                    .disabled(isPasskeyActionRunning || model.deviceCoordinator?.state != .ready)
                    .accessibilityIdentifier("addPasskeyForSync")
                    if model.deviceCoordinator?.state != .ready {
                        Text("Set up encrypted sync before adding a passkey.")
                            .font(.subheadline)
                            .foregroundStyle(TBPalette.muted)
                    }
                } else {
                    ForEach(passkeys) { passkey in
                        HStack(spacing: 12) {
                            Label(passkey.name ?? nativeString( "Passkey"), systemImage: "person.badge.key")
                            Spacer()
                            Text(passkey.backedUp == true ? "Synced" : "This device")
                                .font(.caption)
                                .foregroundStyle(TBPalette.muted)
                            Button(role: .destructive) {
                                passkeyToRemove = passkey
                                isPasskeyRemovalPresented = true
                            } label: {
                                Image(systemName: "trash")
                            }
                            .disabled(isPasskeyActionRunning || model.deviceCoordinator?.state != .ready)
                            .accessibilityLabel("Remove \(passkey.name ?? nativeString( "passkey"))")
                            .accessibilityIdentifier("removePasskey-\(passkey.id)")
                        }
                    }
                }
                if let passkeyMessage {
                    Text(passkeyMessage)
                        .font(.subheadline)
                        .foregroundStyle(TBPalette.muted)
                        .accessibilityIdentifier("passkeyMessage")
                }
                if let passkeyError {
                    Text(passkeyError)
                        .font(.subheadline)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("passkeyError")
                }
            }

            TBSettingsSection(nativeString("Account"), footer: nativeString("Deleting your account permanently removes your account and its cloud data.")) {
                Button("Delete account", role: .destructive) {
                    isAccountDeletionPresented = true
                }
                .accessibilityIdentifier("deleteAccount")
            }
        }
        .tbFont(size: 16)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $isAccountDeletionPresented) {
            AccountDeletionFlow(model: model)
        }
        .confirmationDialog(
            "Remove this passkey?",
            isPresented: $isPasskeyRemovalPresented,
            titleVisibility: .visible
        ) {
            Button("Remove passkey", role: .destructive) {
                guard let passkey = passkeyToRemove else { return }
                performPasskeyAction {
                    try await model.removePasskey(credentialID: passkey.credentialID)
                    passkeys = try await model.loadPasskeys()
                    passkeyMessage = nativeString( "Passkey removed.")
                    passkeyToRemove = nil
                }
            }
            Button("Cancel", role: .cancel) { passkeyToRemove = nil }
        } message: {
            Text("This removes the encrypted sync key from the passkey and rotates the account key before the passkey is deleted.")
        }
        .task { await loadPasskeys() }
    }

    @MainActor private func loadPasskeys() async {
        do { passkeys = try await model.loadPasskeys() }
        catch { passkeyError = error.localizedDescription }
    }

    @MainActor private func performPasskeyAction(_ operation: @escaping () async throws -> Void) {
        guard !isPasskeyActionRunning else { return }
        isPasskeyActionRunning = true
        passkeyError = nil
        passkeyMessage = nil
        Task {
            do { try await operation() }
            catch { passkeyError = error.localizedDescription }
            isPasskeyActionRunning = false
        }
    }
}

private struct RecoveryPhraseChangeFlow: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var verificationCode = ""
    @State private var recoveryPhrase: String?
    @State private var hasRequestedCode = false
    @State private var isWorking = false
    @State private var error: String?

    var body: some View {
        Form {
            if let recoveryPhrase {
                Section {
                    Text(recoveryPhrase)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                        .accessibilityIdentifier("newRecoveryPhrase")
                } header: {
                    Text("Your new recovery phrase")
                } footer: {
                    Text("Save this phrase somewhere private. It replaces the old phrase and cannot be shown again after you confirm.")
                }

                Section {
                    Button("I saved my recovery phrase") {
                        model.acknowledgeRecoveryPhrase()
                        dismiss()
                    }
                    .accessibilityIdentifier("acknowledgeNewRecoveryPhrase")
                }
            } else {
                Section {
                    Text("We’ll email a verification code before changing your recovery phrase.")
                        .font(.subheadline)
                        .foregroundStyle(TBPalette.muted)
                    Button {
                        perform {
                            try await model.requestRecoveryChangeCode()
                            hasRequestedCode = true
                        }
                    } label: {
                        HStack {
                            Text(hasRequestedCode ? "Send another code" : "Send verification code")
                            Spacer()
                            if isWorking { ProgressView() }
                        }
                    }
                    .disabled(isWorking)
                    .accessibilityIdentifier("requestRecoveryChangeCode")
                } header: {
                    Text("Verify your account")
                }

                if hasRequestedCode {
                    Section("Verification code") {
                        TextField("Enter the code", text: $verificationCode)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .accessibilityIdentifier("recoveryChangeCode")
                        Button {
                            perform {
                                recoveryPhrase = try await model.replaceRecoveryPhrase(otp: verificationCode)
                            }
                        } label: {
                            HStack {
                                Text("Replace recovery phrase")
                                Spacer()
                                if isWorking { ProgressView() }
                            }
                        }
                        .disabled(isWorking || verificationCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("replaceRecoveryPhrase")
                    }
                }
            }

            if let error {
                Section {
                    Text(error)
                        .font(.subheadline)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("recoveryPhraseError")
                }
            }
        }
        .scrollContentBackground(.hidden)
        .background(TBPalette.background)
        .navigationTitle("Recovery phrase")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { recoveryPhrase = model.deviceCoordinator?.record?.recoveryPhrase }
        .interactiveDismissDisabled(recoveryPhrase != nil)
    }

    @MainActor private func perform(_ operation: @escaping () async throws -> Void) {
        guard !isWorking else { return }
        isWorking = true
        error = nil
        Task {
            do { try await operation() }
            catch { self.error = error.localizedDescription }
            isWorking = false
        }
    }
}

private struct AccountDeletionFlow: View {
    let model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var verificationCode = ""
    @State private var hasRequestedCode = false
    @State private var isConfirmingDeletion = false
    @State private var isWorking = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Deleting your account is permanent. Your account and its cloud data will be removed.")
                        .font(.subheadline)
                        .foregroundStyle(TBPalette.muted)
                    Button {
                        perform {
                            try await model.requestAccountDeletionCode()
                            hasRequestedCode = true
                        }
                    } label: {
                        HStack {
                            Text(hasRequestedCode ? "Send another code" : "Send verification code")
                            Spacer()
                            if isWorking { ProgressView() }
                        }
                    }
                    .disabled(isWorking)
                    .accessibilityIdentifier("requestAccountDeletionCode")
                } header: {
                    Text("Verify your account")
                }

                if hasRequestedCode {
                    Section("Verification code") {
                        TextField("Enter the code", text: $verificationCode)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .accessibilityIdentifier("accountDeletionCode")
                        Button("Continue to delete account", role: .destructive) {
                            isConfirmingDeletion = true
                        }
                        .disabled(isWorking || verificationCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("confirmAccountDeletion")
                    }
                }

                if let error {
                    Section {
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(.red)
                            .accessibilityIdentifier("accountDeletionError")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(TBPalette.background)
            .navigationTitle("Delete account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button("Cancel") { dismiss() } }
            }
            .confirmationDialog("Delete your account permanently?", isPresented: $isConfirmingDeletion, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) {
                    perform {
                        try await model.deleteAccount(otp: verificationCode)
                        dismiss()
                    }
                }
                .accessibilityIdentifier("confirmPermanentAccountDeletion")
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently removes your account and cloud data. This action cannot be undone.")
            }
        }
        .tint(TBPalette.brand)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isWorking)
    }

    @MainActor private func perform(_ operation: @escaping () async throws -> Void) {
        guard !isWorking else { return }
        isWorking = true
        error = nil
        Task {
            do { try await operation() }
            catch { self.error = error.localizedDescription }
            isWorking = false
        }
    }
}
