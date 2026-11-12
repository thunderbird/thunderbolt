/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct NativeMCPSettingsView: View {
    @Bindable var library: NativeMCPLibrary
    @Environment(\.openURL) private var openURL
    @State private var name = ""
    @State private var url = ""
    @State private var type: NativeMCPTransportKind = .http
    @State private var bearerToken = ""
    @State private var removing: NativeMCPServer?

    var body: some View {
        TBSettingsPage(nativeString("MCP Servers")) {
            TBSettingsSection(nativeString("Saved MCP Servers"), footer: nativeString("Server definitions and credentials stay on this device.")) {
                if library.servers.isEmpty {
                    Text(nativeString("No MCP servers are configured."))
                        .tbFont(size: 14, weight: .regular)
                        .foregroundStyle(TBPalette.muted)
                } else {
                    ForEach(Array(library.servers.enumerated()), id: \.element.id) { index, server in
                        if index > 0 { TBSettingsDivider() }
                        serverRow(server)
                    }
                }
            }

            TBSettingsSection(nativeString("Add MCP Server"), footer: nativeString("Use HTTPS for public servers. HTTP is allowed for local or private network addresses.")) {
                TBSettingsFieldLabel(title: nativeString("Name"))
                TextField(nativeString("Name"), text: $name)
                    .textInputAutocapitalization(.words)
                    .tbSettingsInputStyle()
                    .accessibilityIdentifier("mcpServerName")
                TBSettingsFieldLabel(title: nativeString("Transport"))
                Picker(nativeString("Transport"), selection: $type) {
                    Text("Streamable HTTP").tag(NativeMCPTransportKind.http)
                    Text("Legacy SSE").tag(NativeMCPTransportKind.sse)
                }
                .pickerStyle(.menu)
                .accessibilityIdentifier("mcpServerTransport")
                TBSettingsFieldLabel(title: nativeString("Server URL"))
                TextField("https://example.com/mcp", text: $url)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .tbSettingsInputStyle()
                    .accessibilityIdentifier("mcpServerURL")
                TBSettingsFieldLabel(title: nativeString("Bearer Token (optional)"))
                SecureField(nativeString("Bearer Token (optional)"), text: $bearerToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .tbSettingsInputStyle()
                    .accessibilityIdentifier("mcpServerToken")
                Button(nativeString("Save MCP Server")) {
                    Task {
                        await library.save(name: name, url: url, type: type, bearerToken: bearerToken)
                        if library.error == nil { name = ""; url = ""; bearerToken = "" }
                    }
                }
                .buttonStyle(TBSettingsPrimaryButtonStyle())
                .frame(maxWidth: .infinity)
                .disabled(library.isWorking || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || url.isEmpty)
                .accessibilityIdentifier("saveMCPServer")
            }

            if let error = library.error, !error.isEmpty {
                TBSettingsSection(nativeString("MCP Connection Error")) {
                    Text(error).tbFont(size: 14, weight: .regular).foregroundStyle(.red)
                        .accessibilityIdentifier("mcpLibraryError")
                }
            }
            if let oauthError = library.oauthError, !oauthError.isEmpty {
                TBSettingsSection(nativeString("MCP Authorization Error")) {
                    Text(oauthError).tbFont(size: 14, weight: .regular).foregroundStyle(.red)
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { await library.reload() }
        .confirmationDialog(
            nativeString("Remove MCP server?"),
            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
            presenting: removing
        ) { server in
            Button(nativeString("Remove"), role: .destructive) {
                Task { await library.remove(server); removing = nil }
            }
            Button(nativeString("Cancel"), role: .cancel) { removing = nil }
        } message: { server in
            Text(nativeString("Remove (server.name) and its saved credentials from this device?"))
        }
    }

    @ViewBuilder
    private func serverRow(_ server: NativeMCPServer) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(server.name).tbFont(size: 15, weight: .medium).foregroundStyle(TBPalette.foreground)
                    Text(server.type == .iroh ? nativeString("Iroh transport is not available in this native build.") : server.url)
                        .tbFont(size: 12, weight: .regular).foregroundStyle(TBPalette.muted).lineLimit(2)
                    if let credentialType = server.credentialType {
                        Text(credentialType == "oauth" ? nativeString("OAuth connected") : nativeString("Bearer token saved"))
                            .tbFont(size: 12, weight: .regular).foregroundStyle(TBPalette.brand)
                    }
                }
                Spacer(minLength: 8)
                Toggle(nativeString("Enable (server.name)"), isOn: Binding(
                    get: { server.enabled },
                    set: { value in Task { await library.setEnabled(server, enabled: value) } }
                ))
                .labelsHidden()
                .disabled(library.isWorking || server.type == .iroh)
                .accessibilityIdentifier("mcpEnabled-\(server.id)")
            }
            HStack(spacing: 12) {
                Button(nativeString("Test")) { Task { await library.test(server) } }
                    .disabled(library.isWorking || server.type == .iroh)
                    .accessibilityIdentifier("testMCP-\(server.id)")
                if let tools = library.toolsByServer[server.id] {
                    Text(nativeString("\(tools.count) tools found"))
                        .tbFont(size: 13, weight: .regular).foregroundStyle(TBPalette.muted)
                }
                if server.credentialType != "oauth" && server.type != .iroh {
                    Button(nativeString("Authorize")) {
                        Task {
                            do { openURL(try await library.beginOAuth(serverID: server.id)) }
                            catch { library.error = error.localizedDescription }
                        }
                    }
                    .accessibilityIdentifier("authorizeMCP-\(server.id)")
                }
                Spacer()
                if server.credentialType != nil {
                    Button(nativeString("Disconnect"), role: .destructive) {
                        Task { await library.disconnectCredentials(for: server) }
                    }
                    .disabled(library.isWorking)
                }
                Button(nativeString("Remove"), role: .destructive) { removing = server }
                    .accessibilityIdentifier("removeMCP-\(server.id)")
            }
        }
        .padding(.vertical, 4)
    }
}
