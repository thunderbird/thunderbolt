/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct NativeAgentsSettingsView: View {
    let library: NativeAgentsLibrary
    var allowCustomAgents = true
    @State private var showingEditor = false
    @State private var editingAgent: NativeACPAgent?
    @State private var deletingAgent: NativeACPAgent?
    @State private var errorMessage: String?

    var body: some View {
        TBSettingsPage(nativeString("Agents")) {
            if let errorMessage {
                Text(errorMessage)
                    .tbFont(size: 14)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("agentsError")
            }
            agentGroups
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if allowCustomAgents {
                Button { editingAgent = nil; showingEditor = true } label: {
                    Label(nativeString("Add Custom Agent"), systemImage: "plus")
                }
                .buttonStyle(TBSettingsPrimaryButtonStyle())
                .accessibilityIdentifier("addACPAgent")
                .padding(.horizontal, 20)
                .padding(.top, 10)
                .padding(.bottom, 8)
                .frame(maxWidth: .infinity)
                .background(TBPalette.background.opacity(0.96))
            }
        }
        .sheet(isPresented: $showingEditor) {
            NativeACPAgentEditor(library: library, agent: editingAgent) {
                showingEditor = false
                Task { try? await library.refresh() }
            }
        }
        .confirmationDialog(nativeString("Delete this agent?"), isPresented: Binding(
            get: { deletingAgent != nil }, set: { if !$0 { deletingAgent = nil } }
        ), titleVisibility: .visible) {
            Button(nativeString("Delete Agent"), role: .destructive) {
                guard let deletingAgent else { return }
                Task {
                    do { try await library.delete(deletingAgent.id); errorMessage = nil }
                    catch { errorMessage = error.localizedDescription }
                    self.deletingAgent = nil
                }
            }
            Button(nativeString("Cancel"), role: .cancel) { deletingAgent = nil }
        }
        .task { library.start(); try? await library.refresh() }
        .onDisappear { library.stop() }
    }

    @ViewBuilder
    private var agentGroups: some View {
        let systemAgents = library.agents.filter { $0.type != .builtIn && $0.isSystem }
        let yourAgents = library.agents.filter { $0.type == .builtIn || !$0.isSystem }
        let showSections = !systemAgents.isEmpty && !yourAgents.isEmpty
        if showSections {
            TBSettingsSection(nativeString("Your Agents"), footer: nativeString("Agent API keys stay on this device.")) {
                rows(yourAgents)
            }
            TBSettingsSection(nativeString("System Agents")) { rows(systemAgents) }
        } else {
            TBSettingsSection(nativeString("Agents"), footer: nativeString("Custom ACP agents sync with your account. Agent API keys stay on this device.")) {
                rows(library.agents)
            }
        }
    }

    @ViewBuilder
    private func rows(_ agents: [NativeACPAgent]) -> some View {
        if agents.isEmpty {
            Text(nativeString("No agents added yet"))
                .tbFont(size: 14)
                .foregroundStyle(TBPalette.muted)
        } else {
            ForEach(Array(agents.enumerated()), id: \.element.id) { index, agent in
                if index > 0 { TBSettingsDivider() }
                agentRow(agent)
            }
        }
    }

    @ViewBuilder
    private func agentRow(_ agent: NativeACPAgent) -> some View {
        HStack(spacing: 12) {
            Button { editingAgent = agent; showingEditor = true } label: {
                HStack(spacing: 12) {
                    Image(systemName: agent.isSystem ? "server.rack" : "point.3.connected.trianglepath.dotted")
                        .tbFont(size: 18, weight: .medium)
                        .foregroundStyle(TBPalette.brand)
                        .frame(width: 40, height: 40)
                        .background(TBPalette.secondary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(agent.name).tbFont(size: 16, weight: .medium).foregroundStyle(TBPalette.foreground).lineLimit(1)
                            if agent.isDefault {
                                Text(nativeString("Default"))
                                    .tbFont(size: 11, weight: .medium)
                                    .foregroundStyle(TBPalette.brand)
                            }
                        }
                        Text(agent.description?.isEmpty == false ? agent.description! : agent.url)
                            .tbFont(size: 13)
                            .foregroundStyle(TBPalette.muted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    if !agent.isSystem { Image(systemName: "chevron.right").foregroundStyle(TBPalette.muted) }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(agent.isSystem)
            .accessibilityIdentifier("agent-\(agent.id)")

            if !agent.isSystem {
                Toggle(nativeString("Enabled"), isOn: Binding(
                    get: { agent.enabled },
                    set: { value in Task { do { try await library.setEnabled(value, id: agent.id) } catch { errorMessage = error.localizedDescription } } }
                ))
                .labelsHidden()
                .tint(TBPalette.brand)
                .accessibilityIdentifier("agentEnabled-\(agent.id)")
                Button(role: .destructive) { deletingAgent = agent } label: {
                    Image(systemName: "trash")
                        .tbFont(size: 15)
                        .foregroundStyle(TBPalette.muted)
                        .frame(width: 38, height: 38)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(nativeString("Delete agent"))
                .accessibilityIdentifier("deleteAgent-\(agent.id)")
            }
        }
    }
}

private struct NativeACPAgentEditor: View {
    let library: NativeAgentsLibrary
    let agent: NativeACPAgent?
    let onClose: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var url: String
    @State private var detail: String
    @State private var type: NativeACPAgentType
    @State private var tested = false
    @State private var testing = false
    @State private var errorMessage: String?

    init(library: NativeAgentsLibrary, agent: NativeACPAgent?, onClose: @escaping () -> Void) {
        self.library = library
        self.agent = agent
        self.onClose = onClose
        _name = State(initialValue: agent?.name ?? "")
        _url = State(initialValue: agent?.url ?? "")
        _detail = State(initialValue: agent?.description ?? "")
        _type = State(initialValue: agent?.type == .managed ? .managed : .remote)
    }

    private var validSecureURL: Bool {
        guard let parsed = URL(string: url.trimmingCharacters(in: .whitespacesAndNewlines)) else { return false }
        return parsed.scheme?.lowercased() == "wss" && parsed.host != nil && parsed.user == nil && parsed.password == nil
    }

    var body: some View {
        NavigationStack {
            TBSettingsPage(agent == nil ? nativeString("Add Agent") : nativeString("Edit Agent"), scrolling: true,
                           leading: AnyView(TBSettingsHeaderButton(systemName: "xmark", identifier: "closeAgentEditor") { dismiss() }),
                           trailing: AnyView(Color.clear)) {
                TBSettingsSection(nativeString("Remote Agent"), footer: nativeString("The endpoint must speak ACP over a secure WebSocket. iroh pairing is handled separately.")) {
                    field(nativeString("Name"), placeholder: nativeString("My Agent"), text: $name, id: "agentName")
                    field(nativeString("WebSocket URL"), placeholder: "wss://example.com/ws", text: $url, id: "agentURL")
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !url.isEmpty && !validSecureURL {
                        Text(nativeString("Enter a valid wss:// URL. iOS does not allow insecure ws:// agents."))
                            .tbFont(size: 13).foregroundStyle(.red)
                    }
                    field(nativeString("Description"), placeholder: nativeString("Optional"), text: $detail, id: "agentDescription")
                    Picker(nativeString("Agent type"), selection: $type) {
                        Text(nativeString("Remote ACP")).tag(NativeACPAgentType.remote)
                        Text(nativeString("Managed ACP")).tag(NativeACPAgentType.managed)
                    }
                    .tint(TBPalette.brand)
                    Button {
                        Task { await testConnection() }
                    } label: {
                        HStack {
                            if testing { ProgressView().tint(TBPalette.brandForeground) }
                            Text(testing ? nativeString("Connecting…") : nativeString("Test Connection"))
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    .disabled(!validSecureURL || testing)
                    .accessibilityIdentifier("testACPConnection")
                    if tested { Label(nativeString("Connection successful"), systemImage: "checkmark.circle.fill").foregroundStyle(TBPalette.brand) }
                    if let errorMessage { Text(errorMessage).tbFont(size: 13).foregroundStyle(.red).accessibilityIdentifier("agentEditorError") }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button(agent == nil ? nativeString("Add Agent") : nativeString("Save Changes")) {
                    Task { await save() }
                }
                .buttonStyle(TBSettingsPrimaryButtonStyle())
                .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !validSecureURL || !tested)
                .accessibilityIdentifier("saveACPAgent")
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(TBPalette.background)
            }
        }
        .presentationDragIndicator(.visible)
        .presentationDetents([.large])
    }

    private func field(_ title: String, placeholder: String, text: Binding<String>, id: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            TBSettingsFieldLabel(title: title)
            TextField(placeholder, text: text).tbSettingsInputStyle().accessibilityIdentifier(id)
        }
    }

    @MainActor
    private func testConnection() async {
        testing = true
        errorMessage = nil
        tested = false
        do {
            let connection = try await NativeACPConnection.connect(url: url)
            await connection.close()
            tested = true
        } catch { errorMessage = error.localizedDescription }
        testing = false
    }

    @MainActor
    private func save() async {
        guard tested else { return }
        do {
            if let agent {
                try await library.update(agent.id, name: name, url: url, description: detail, type: type)
            } else {
                _ = try await library.add(name: name, url: url, description: detail, type: type)
            }
            onClose()
        } catch { errorMessage = error.localizedDescription }
    }
}
