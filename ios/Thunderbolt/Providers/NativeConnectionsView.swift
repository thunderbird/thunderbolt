/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct NativeConnectionsView: View {
    @Bindable var library: NativeProviderConnectionLibrary

    @State private var provider: NativeProviderType = .openAI
    @State private var name = ""
    @State private var url = ""
    @State private var apiKey = ""
    @State private var removing: NativeProviderConnection?

    var body: some View {
        TBSettingsPage(nativeString( "Connections")) {
            TBSettingsSection(nativeString( "Saved connections")) {
                if library.connections.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(nativeString( "No connections"), systemImage: "link")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(TBPalette.foreground)
                        Text(nativeString( "Add an API key or connect your Tinfoil account."))
                            .font(.system(size: 14))
                            .foregroundStyle(TBPalette.muted)
                    }
                } else {
                    ForEach(Array(library.connections.enumerated()), id: \.element.id) { index, connection in
                        if index > 0 { TBSettingsDivider() }
                        connectionRow(connection)
                    }
                }
            }

            TBSettingsSection(nativeString( "Add a connection"), footer: nativeString( "Credentials are stored on this device. Connection names and provider settings sync with your account.")) {
                TBSettingsFieldLabel(title: nativeString( "Provider"))
                Picker(nativeString( "Provider"), selection: $provider) {
                    ForEach(NativeProviderType.allCases) { option in
                        Text(option.displayName).tag(option)
                    }
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("connectionProvider")

                TextField(nativeString( "Name"), text: $name)
                    .textInputAutocapitalization(.words)
                    .tbSettingsInputStyle()
                    .accessibilityIdentifier("connectionName")

                if provider.requiresURL {
                    TextField(nativeString( "Server URL"), text: $url, prompt: Text(provider.defaultURL ?? "https://example.com/v1"))
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                    .tbSettingsInputStyle()
                        .accessibilityIdentifier("connectionURL")
                }

                SecureField(
                    provider == .custom ? nativeString( "API key (optional)") : nativeString( "API key"),
                    text: $apiKey
                )
                .textInputAutocapitalization(.never)
                .tbSettingsInputStyle()
                .accessibilityIdentifier("connectionAPIKey")

                Button(nativeString( "Save connection"), action: { Task { await saveAPIKey() } })
                    .disabled(library.isWorking || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .buttonStyle(TBSettingsPrimaryButtonStyle())
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("saveProviderConnection")

                if provider == .tinfoil {
                    Button(nativeString( "Connect with Tinfoil"), action: { Task { await library.beginTinfoilOAuth() } })
                        .disabled(library.isWorking)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .accessibilityIdentifier("connectTinfoilOAuth")
                }
            }

            if let error = library.error, !error.isEmpty {
                TBSettingsSection(nativeString( "Connection error")) {
                    Text(error)
                        .font(.system(size: 14))
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("providerConnectionError")
                }
            }
        }
        .task { await library.reload() }
        .confirmationDialog(
            nativeString( "Remove connection?"),
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            presenting: removing
        ) { connection in
            Button(nativeString( "Remove"), role: .destructive) {
                Task { await library.remove(connection); removing = nil }
            }
            Button(nativeString( "Cancel"), role: .cancel) { removing = nil }
        } message: { connection in
            Text(nativeString( "Models using \(connection.name) will become unavailable. Chat history will be kept."))
        }
    }

    @ViewBuilder
    private func connectionRow(_ connection: NativeProviderConnection) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(connection.name)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(TBPalette.foreground)
                    Text(connection.provider.displayName)
                        .font(.system(size: 13))
                        .foregroundStyle(TBPalette.muted)
                }
                Spacer()
                Toggle(
                    nativeString( "Enabled"),
                    isOn: Binding(
                        get: { connection.enabled },
                        set: { enabled in Task { await library.setEnabled(connection, enabled: enabled) } }
                    )
                )
                .labelsHidden()
                .disabled(library.isWorking)
                .tint(TBPalette.brand)
                .accessibilityLabel(nativeString( "Enable \(connection.name)"))
            }
            HStack {
                Label(
                    connection.connected ? nativeString( "Connected on this device") : nativeString( "Not connected on this device"),
                    systemImage: connection.connected ? "checkmark.circle.fill" : "circle.dashed"
                )
                .font(.system(size: 13))
                .foregroundStyle(connection.connected ? TBPalette.brand : TBPalette.muted)
                Spacer()
                Button(nativeString( "Disconnect")) { Task { await library.disconnect(connection) } }
                    .disabled(library.isWorking || !connection.connected)
                    .font(.system(size: 14, weight: .medium))
                Menu {
                    Button(nativeString( "Remove connection"), role: .destructive) { removing = connection }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                        .foregroundStyle(TBPalette.foreground)
                }
                .accessibilityLabel(nativeString( "Actions for \(connection.name)"))
            }
        }
        .padding(.vertical, 2)
    }

    private func saveAPIKey() async {
        await library.saveAPIKey(provider: provider, name: name, url: url.isEmpty ? nil : url, apiKey: apiKey)
        if library.error == nil {
            name = ""
            url = ""
            apiKey = ""
        }
    }
}
