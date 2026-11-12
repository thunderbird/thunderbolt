/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct SettingsView: View {
    @Bindable var model: AppModel
    @State private var serverDraft = ""
    @State private var isSavingServer = false

    var body: some View {
        TBSettingsPage(nativeString("Account")) {
            if let session = model.session {
                TBSettingsSection(nativeString("Account")) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(session.user.email).tbFont(size: 16, weight: .medium)
                        Text(model.isSyncEnabled ? nativeString("Chats sync with end-to-end encryption.") : nativeString("Chats are stored only on this device."))
                            .tbFont(size: 14).foregroundStyle(TBPalette.muted)
                    }
                    NavigationLink {
                        SecuritySettingsView(model: model)
                            .environment(\.tbSettingsSidebarAction, nil)
                    } label: {
                        HStack {
                            Label("Security", systemImage: "lock.shield")
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(TBPalette.muted)
                        }
                        .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityIdentifier("openSecuritySettings")
                    TBSettingsDivider()
                    Button("Sign Out", role: .destructive) { Task { await model.signOut() } }
                        .frame(minHeight: 44).disabled(model.isSigningOut).accessibilityIdentifier("signOut")
                }
            }

            TBSettingsSection(nativeString("Sync")) {
                Button { model.syncSetupPresented = true } label: {
                    Label(model.isSyncEnabled ? nativeString("Encrypted sync") : nativeString("Set up sync"), systemImage: "lock.icloud")
                        .frame(minHeight: 44)
                }
                .buttonStyle(.plain).accessibilityIdentifier("setupSync")
                if let status = model.syncStatus {
                    HStack {
                        Text("Sync status")
                        Spacer()
                        Text(syncStatusLabel(status)).foregroundStyle(TBPalette.muted)
                    }
                    .accessibilityIdentifier("syncStatus")
                    if let lastSynced = status.lastSyncedAt {
                        HStack { Text("Last synced"); Spacer(); Text(lastSynced, style: .relative).foregroundStyle(TBPalette.muted) }
                    }
                }
                if let error = model.syncError { Text(error).tbFont(size: 14).foregroundStyle(.red) }
            }

            TBSettingsSection(nativeString("Server"), footer: nativeString("Sign-in and chat history are kept on this device for each server. Switching back can restore that server's session.")) {
                TextField("Server URL", text: $serverDraft)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .tbSettingsInputStyle().accessibilityIdentifier("serverURL")
                Button {
                    isSavingServer = true
                    Task { await model.changeServer(serverDraft); isSavingServer = false }
                } label: {
                    HStack { Text("Save server"); if isSavingServer { ProgressView() } }
                }
                .buttonStyle(TBSettingsPrimaryButtonStyle())
                .disabled(isSavingServer || serverDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("saveServer")
                if let error = model.authError, !error.isEmpty {
                    Text(error).tbFont(size: 14).foregroundStyle(.red).accessibilityIdentifier("settingsError")
                }
            }
        }
        .tbFont(size: 16)
        .toolbar(.hidden, for: .navigationBar)
        .onAppear { serverDraft = model.serverURL }
        .sheet(isPresented: $model.syncSetupPresented) { SyncSetupView(model: model) }
    }

    private func syncStatusLabel(_ status: NativeSyncStatusSnapshot) -> String {
        if status.hasError { return nativeString("Waiting to reconnect") }
        if status.connecting { return nativeString("Connecting…") }
        if status.uploading || status.downloading { return nativeString("Syncing…") }
        if status.connected { return nativeString("Up to date") }
        return nativeString("Offline")
    }
}
