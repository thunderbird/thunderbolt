/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct HistoryView: View {
    @Bindable var model: AppModel
    @Binding var settingsSection: Bool
    let destination: NativeDestination?
    let onNavigate: (NativeDestination) -> Void
    let onClose: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isSearching = false
    @State private var searchText = ""
    @State private var searchResults: [NativeProjectSearch.Hit] = []
    @State private var searchError: String?
    @State private var renameTarget: String?
    @State private var renameText = ""
    @State private var deleteTarget: String?
    @FocusState private var searchFocused: Bool
    @ScaledMetric(relativeTo: .body) private var bodySize = 16.0

    init(model: AppModel, settingsSection: Binding<Bool>, destination: NativeDestination?,
         onNavigate: @escaping (NativeDestination) -> Void, onClose: @escaping () -> Void) {
        self.model = model
        self._settingsSection = settingsSection
        self.destination = destination
        self.onNavigate = onNavigate
        self.onClose = onClose
    }

    private var recentConversations: [Conversation] {
        model.conversations
            .filter { $0.deletedAt == nil && ($0.projectID == nil || !searchText.isEmpty) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private var filteredConversations: [Conversation] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return recentConversations }
        let byID = Dictionary(uniqueKeysWithValues: recentConversations.map { ($0.id, $0) })
        return searchResults.compactMap { byID[$0.threadID] }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 8)
                .padding(.top, 4)
                .padding(.bottom, 8)

            if isSearching {
                searchField
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }

            if settingsSection {
                settingsNavigation
            } else {
            List {
                if let searchError {
                    Text(searchError).foregroundStyle(.red).font(.subheadline)
                        .listRowBackground(TBPalette.sidebar)
                }
                if searchText.isEmpty {
                    ProjectTree(model: model, onClose: onClose) { conversation in conversationRow(conversation) }
                }
                if model.chatError != nil {
                    Section {
                        historyErrorNotice
                            .listRowBackground(TBPalette.sidebar)
                            .listRowSeparator(.hidden)
                    }
                }

                if filteredConversations.isEmpty {
                    Section {
                        Text(recentConversations.isEmpty ? nativeString( "No chats yet") : nativeString( "No matching chats"))
                            .font(.subheadline)
                            .foregroundStyle(TBPalette.muted)
                            .frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)
                            .listRowBackground(TBPalette.sidebar)
                            .listRowSeparator(.hidden)
                    } header: {
                        Text("Recents").font(.caption.weight(.medium))
                    }
                } else {
                    Section {
                        ForEach(filteredConversations) { conversation in
                            conversationRow(conversation)
                                .listRowBackground(TBPalette.sidebar)
                                .listRowSeparator(.hidden)
                                .listRowInsets(EdgeInsets(top: 2, leading: 8, bottom: 2, trailing: 8))
                        }
                    } header: {
                        Text("Recents").font(.caption.weight(.medium))
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(TBPalette.sidebar)
            .contentMargins(.top, 0, for: .scrollContent)

            }
            footer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(TBPalette.sidebar.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("historySidebar")
        .sheet(isPresented: $model.syncSetupPresented) { SyncSetupView(model: model) }
        .alert("Rename chat", isPresented: Binding(get: { renameTarget != nil }, set: { if !$0 { renameTarget = nil } }), presenting: renameTarget) { target in
            TextField("Chat name", text: $renameText).accessibilityIdentifier("renameChatInput")
            Button("Cancel", role: .cancel) { renameTarget = nil }
            Button("Save") {
                Task { await model.renameConversation(target, title: renameText) }
                renameTarget = nil
            }.disabled(renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .confirmationDialog("Delete chat?", isPresented: Binding(get: { deleteTarget != nil }, set: { if !$0 { deleteTarget = nil } }), titleVisibility: .visible, presenting: deleteTarget) { target in
            Button("Delete chat", role: .destructive) {
                Task { await model.deleteConversation(target) }
                deleteTarget = nil
            }
        }
        .onChange(of: isSearching) { _, searching in
            if searching {
                searchFocused = true
            } else {
                searchText = ""
                searchFocused = false
            }
        }
        .task(id: searchText) {
            let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            searchError = nil
            guard !query.isEmpty else { searchResults = []; return }
            let conversations = model.conversations
            let worker = Task.detached(priority: .userInitiated) { try NativeChatSearch.find(query, conversations: conversations) }
            do {
                let results = try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
                try Task.checkCancellation()
                searchResults = results
            } catch is CancellationError {
            } catch { if !Task.isCancelled { searchResults = []; searchError = error.localizedDescription } }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button { TBHaptics.selection(); settingsSection = false } label: {
            Image(systemName: "bubble.left")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(TBPalette.foreground)
                .frame(width: 48, height: 48)
                .background(settingsSection ? Color.clear : TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
            }
            .buttonStyle(.plain).accessibilityLabel("Chats").accessibilityIdentifier("showChatsSection")

            if model.preferences?.tasksEnabled == true {
                Button { onNavigate(.tasks) } label: {
                    Image(systemName: "checklist")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(TBPalette.foreground)
                        .frame(width: 48, height: 48)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Tasks")
                .accessibilityIdentifier("openTasks")
            }

            Button {
                TBHaptics.selection()
                settingsSection = true
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(TBPalette.foreground)
                    .frame(width: 48, height: 48)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Settings")
            .accessibilityIdentifier("openSettings")
            .background(settingsSection ? TBPalette.surface : Color.clear, in: RoundedRectangle(cornerRadius: 16))

            Spacer(minLength: 4)

            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                    settingsSection = false
                    isSearching.toggle()
                }
            } label: {
                Image(systemName: isSearching ? "xmark" : "magnifyingglass")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(TBPalette.foreground)
                    .frame(width: 48, height: 48)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isSearching ? "Cancel search" : "Search chats")
            .accessibilityIdentifier("searchChats")
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(TBPalette.muted)
            TextField(
                "Search chats",
                text: $searchText,
                prompt: Text("Search chats").foregroundStyle(TBPalette.muted)
            )
                .focused($searchFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("searchChatsField")
            if !searchText.isEmpty {
                Button {
                    searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(TBPalette.muted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 14))
    }

    private func conversationRow(_ conversation: Conversation) -> some View {
        Button {
            searchFocused = false
            Task { await model.selectConversation(conversation.id) }
            onClose()
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title.isEmpty ? nativeString( "New Chat") : conversation.title)
                    .font(.system(size: bodySize))
                    .foregroundStyle(TBPalette.foreground)
                    .lineLimit(1)
                if !searchText.isEmpty, let hit = searchResults.first(where: { $0.threadID == conversation.id }), !hit.excerpt.isEmpty {
                    Text(hit.excerpt).font(.caption).foregroundStyle(TBPalette.muted).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .padding(.horizontal, 10)
            .background(
                model.selectedConversationID == conversation.id ? TBPalette.surface : .clear,
                in: RoundedRectangle(cornerRadius: 12)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("historyConversation-\(conversation.id)")
        .contextMenu {
            Button("Rename", systemImage: "pencil") { renameText = conversation.title; renameTarget = conversation.id }
            if let projects = model.projectLibrary?.projects, !projects.isEmpty {
                Menu("Move", systemImage: "folder") {
                    ForEach(projects) { project in
                        Button(project.name) { Task { await model.moveConversation(conversation.id, to: project.id) } }
                    }
                    if conversation.projectID != nil {
                        Button("Remove from project") { Task { await model.moveConversation(conversation.id, to: nil) } }
                    }
                }
            }
            Button("Delete", systemImage: "trash", role: .destructive) { deleteTarget = conversation.id }
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                deleteTarget = conversation.id
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private var settingsNavigation: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                settingsGroup(nativeString("What agents use"), pages: [.skills, .connections, .models] + (model.customVoiceEnabled ? [.voice] : []))
                settingsGroup(nativeString("Settings"), pages: [.preferences, .devices])
            }
            .padding(.horizontal, 8)
            .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func settingsGroup(_ title: String, pages: [NativeDestination]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).tbFont(size: 12, weight: .medium).foregroundStyle(TBPalette.muted)
                .padding(.horizontal, 8).padding(.bottom, 4)
            ForEach(pages) { page in
                Button { TBHaptics.selection(); onNavigate(page) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: page.symbol).frame(width: 20)
                        Text(page.title)
                        Spacer()
                    }
                    .tbFont(size: 16)
                    .foregroundStyle(TBPalette.foreground)
                    .padding(.horizontal, 12).frame(minHeight: 44)
                    .background(destination == page ? TBPalette.surface : Color.clear, in: RoundedRectangle(cornerRadius: 12))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityIdentifier(page.controlID)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Menu {
                if let email = model.session?.user.email, !email.isEmpty {
                    Text(email)
                }
                Button("Account", systemImage: "person.crop.circle") { onNavigate(.account) }
                .accessibilityIdentifier("accountSettings")
                Button(model.isSyncEnabled ? nativeString("Encrypted sync") : nativeString("Set up sync"), systemImage: "lock.icloud") {
                    model.syncSetupPresented = true
                }
                .accessibilityIdentifier("setupSync")
                Button("Sign Out", systemImage: "rectangle.portrait.and.arrow.right") {
                    Task { await model.signOut() }
                }
                .disabled(model.isSigningOut)
                .accessibilityIdentifier("signOut")
            } label: {
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(TBPalette.foreground)
                    .frame(width: 48, height: 48)
                    .background(TBPalette.surface, in: Circle())
                    .contentShape(Circle())
            }
            .accessibilityLabel("Account")
            .accessibilityIdentifier("accountMenu")

            Spacer(minLength: 8)

            Button {
                searchFocused = false
                Task { await model.newChat() }
                onClose()
            } label: {
                Label("New Chat", systemImage: "plus.bubble")
                    .font(.body.weight(.semibold))
                    .padding(.horizontal, 18)
                    .frame(minHeight: 48)
                    .foregroundStyle(TBPalette.brandForeground)
                    .background(
                        LinearGradient(
                            colors: [TBPalette.brandAmber, TBPalette.brand],
                            startPoint: .leading,
                            endPoint: .trailing
                        ),
                        in: Capsule()
                    )
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("historyNewChat")
        }
        .padding(.horizontal, 8)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background(TBPalette.sidebar)
    }

    @ViewBuilder
    private var historyErrorNotice: some View {
        if let error = model.chatError, !error.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.subheadline)
                    .foregroundStyle(TBPalette.foreground)
                Button("Try again") {
                    Task { await model.recoverFromChatError() }
                }
                .font(.subheadline.weight(.semibold))
                .disabled(model.isStreaming || model.isLoadingModels)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TBPalette.brandAmber.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
            .accessibilityIdentifier("historyError")
        }
    }
}
