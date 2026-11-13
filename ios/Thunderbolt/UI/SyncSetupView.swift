/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct SyncSetupView: View {
    @Bindable var model: AppModel
    var allowsDismissal = true
    @Environment(\.dismiss) private var dismiss
    @State private var savedRecoveryKey = false
    @State private var recoveryPhrase = ""
    @State private var showRecovery = false
    @State private var approvalRequested = false
    @State private var passkeys: [NativePasskeyRecord] = []
    @State private var passkeyLoadError: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    Image(systemName: "lock.icloud")
                        .font(.system(size: 42, weight: .light))
                        .foregroundStyle(TBPalette.brand)
                        .frame(maxWidth: .infinity)
                    content
                    if let error = model.syncError {
                        Text(error).font(.subheadline).foregroundStyle(.red)
                            .accessibilityIdentifier("syncError")
                    }
                }
                .padding(24)
            }
            .background(TBPalette.background)
            .navigationTitle("Set up sync")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if allowsDismissal {
                        Button("Close", systemImage: "xmark") { dismiss() }
                            .accessibilityIdentifier("closeSync")
                    } else {
                        Button("Sign Out") { Task { await model.signOut() } }
                            .accessibilityIdentifier("signOut")
                    }
                }
            }
            .task(id: approvalRequested) {
                guard approvalRequested else { return }
                while !Task.isCancelled && model.deviceCoordinator?.state == .awaitingApproval {
                    await model.pollDeviceApproval()
                    do { try await Task.sleep(for: .seconds(2)) }
                    catch { return }
                }
            }
            .task { await loadPasskeysIfNeeded() }
            .onChange(of: model.deviceCoordinator?.state) { _, state in
                guard state == .awaitingApproval else { return }
                Task { await loadPasskeysIfNeeded() }
            }
        }
        .tint(TBPalette.brand)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    @ViewBuilder private var content: some View {
        if let phrase = model.deviceCoordinator?.record?.recoveryPhrase, model.isSyncEnabled {
            Text("Save your recovery key")
                .font(.title2.weight(.semibold))
            Text("Keep these 24 words somewhere safe. You can use them to unlock your encrypted chats on another device.")
                .foregroundStyle(TBPalette.muted)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 12) {
                ForEach(Array(phrase.split(separator: " ").enumerated()), id: \.offset) { index, word in
                    HStack(spacing: 6) {
                        Text((index + 1).formatted()).foregroundStyle(TBPalette.muted).font(.caption)
                        Text(String(word)).font(.system(.subheadline, design: .monospaced))
                    }
                    .privacySensitive()
                }
            }
            .padding(16)
            .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 20))
            .accessibilityIdentifier("recoveryPhrase")
            Toggle("I saved my recovery key", isOn: $savedRecoveryKey)
                .accessibilityIdentifier("savedRecoveryKey")
            Button {
                model.acknowledgeRecoveryPhrase()
                if model.deviceCoordinator?.record?.recoveryPhrase == nil { dismiss() }
            } label: { Text("Continue").frame(maxWidth: .infinity).frame(height: 48) }
                .buttonStyle(TBPrimaryButtonStyle())
                .disabled(!savedRecoveryKey)
                .accessibilityIdentifier("confirmRecoveryKey")
        } else if model.isSyncEnabled {
            Text("Your chats are encrypted")
                .font(.title2.weight(.semibold))
            Text(model.deviceCoordinator?.state == .offline
                 ? nativeString( "You can read your saved chats offline. Sync resumes after this device reconnects and verifies its keys.")
                 : nativeString( "This device is connected to your encrypted account. Changes made offline sync when the connection returns."))
                .foregroundStyle(TBPalette.muted)
                .accessibilityIdentifier("syncReady")
        } else if model.deviceCoordinator?.state == .awaitingApproval {
            Text("Unlock your encrypted account")
                .font(.title2.weight(.semibold))
            Text("This account already has encryption set up. Use your recovery key or approve this device from a trusted device.")
                .foregroundStyle(TBPalette.muted)
                .accessibilityIdentifier("syncNeedsApproval")
            if showRecovery {
                TextField("24-word recovery key", text: $recoveryPhrase, axis: .vertical)
                    .lineLimit(4...8)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.system(.body, design: .monospaced))
                    .padding(16)
                    .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
                    .privacySensitive()
                    .accessibilityIdentifier("recoveryKeyInput")
                Button {
                    let phrase = recoveryPhrase
                    Task {
                        await model.recoverSync(phrase: phrase)
                        if model.isSyncEnabled { recoveryPhrase = "" }
                    }
                } label: {
                    HStack {
                        if model.isConnectingSync { ProgressView().tint(TBPalette.brandForeground) }
                        Text("Unlock")
                    }.frame(maxWidth: .infinity).frame(height: 48)
                }
                .buttonStyle(TBPrimaryButtonStyle())
                .disabled(model.isConnectingSync || recoveryPhrase.split(whereSeparator: \.isWhitespace).count != 24)
                .accessibilityIdentifier("unlockRecovery")
            } else {
                ForEach(passkeys) { passkey in
                    Button {
                        Task {
                            await model.unlockSyncWithPasskey(credentialID: passkey.credentialID)
                            if model.isSyncEnabled { dismiss() }
                        }
                    } label: {
                        Text("Unlock with \(passkey.name ?? nativeString( "passkey"))")
                            .frame(maxWidth: .infinity)
                            .frame(height: 48)
                    }
                    .buttonStyle(.bordered)
                    .disabled(model.isConnectingSync)
                    .accessibilityIdentifier("unlockWithPasskey-\(passkey.id)")
                }
                if let passkeyLoadError {
                    Text(passkeyLoadError)
                        .font(.subheadline)
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("passkeyLoadError")
                }
                Button("Use recovery key") { showRecovery = true }
                    .accessibilityIdentifier("useRecoveryKey")
                if let code = model.deviceCoordinator?.approvalCode {
                    Text(code).font(.system(size: 36, weight: .semibold, design: .monospaced))
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("deviceApprovalCode")
                    Text("Choose this code on your trusted device.").foregroundStyle(TBPalette.muted)
                } else if approvalRequested {
                    ProgressView("Waiting for your trusted device…")
                } else {
                    Button {
                        Task {
                            await model.startDeviceApproval()
                            approvalRequested = model.syncError == nil
                        }
                    } label: { Text("Approve on another device").frame(maxWidth: .infinity).frame(height: 48) }
                        .buttonStyle(TBPrimaryButtonStyle())
                        .accessibilityIdentifier("startDeviceApproval")
                }
            }
        } else {
            Text("Sync across your devices")
                .font(.title2.weight(.semibold))
            Text("Your chats are encrypted on this device before they sync. Only your trusted devices can read them.")
                .foregroundStyle(TBPalette.muted)
            Button {
                Task { await model.enableSync() }
            } label: {
                HStack {
                    if model.isConnectingSync { ProgressView().tint(TBPalette.brandForeground) }
                    Text(model.isConnectingSync ? nativeString( "Setting up encryption…") : nativeString( "Enable sync"))
                }
                .frame(maxWidth: .infinity).frame(height: 48)
            }
            .buttonStyle(TBPrimaryButtonStyle())
            .disabled(model.isConnectingSync)
            .accessibilityIdentifier("enableSync")
        }
    }

    @MainActor private func loadPasskeysIfNeeded() async {
        guard model.deviceCoordinator?.state == .awaitingApproval else { return }
        do { passkeys = try await model.loadPasskeys() }
        catch { passkeyLoadError = error.localizedDescription }
    }
}
