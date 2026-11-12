/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct ProjectTree<Row: View>: View {
    let model: AppModel
    let onClose: () -> Void
    @ViewBuilder let chatRow: (Conversation) -> Row
    @State private var expanded: Set<String> = []
    @State private var isExpanded = true
    @State private var limit = 5
    @State private var chatLimits: [String: Int] = [:]
    @State private var editor: NativeProject?
    @State private var deleting: NativeProject?

    var body: some View {
        if let library = model.projectLibrary {
            Section {
                if isExpanded {
                    let ordered = library.sorted(conversations: model.conversations)
                    let capped = Array(ordered.prefix(limit))
                    let active = ordered.filter { $0.id == model.selectedProjectID && !capped.contains($0) }
                    ForEach(capped + active) { project in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 2) {
                                Button {
                                    if expanded.contains(project.id) { expanded.remove(project.id) }
                                    else { expanded.insert(project.id) }
                                } label: {
                                    Image(systemName: expanded.contains(project.id) ? "chevron.down" : "chevron.right")
                                        .font(.caption.weight(.medium)).frame(width: 28, height: 44)
                                }.buttonStyle(.plain).accessibilityLabel("Expand \(project.name)")
                                Button {
                                    Task { await model.newChat(projectID: project.id) }
                                    expanded.insert(project.id)
                                    onClose()
                                } label: {
                                    HStack(spacing: 8) {
                                        ProjectGlyph(project: project)
                                        Text(project.name).lineLimit(1)
                                        Spacer(minLength: 0)
                                        if project.pinnedOrder != nil { Image(systemName: "pin.fill").font(.caption) }
                                    }.frame(minHeight: 44)
                                }.buttonStyle(.plain).accessibilityIdentifier("project-\(project.id)")
                            }
                            .foregroundStyle(TBPalette.foreground)
                            .contextMenu {
                                Button("New chat", systemImage: "plus.bubble") {
                                    Task { await model.newChat(projectID: project.id) }; onClose()
                                }
                                Button(project.pinnedOrder == nil ? "Pin" : "Unpin", systemImage: "pin") {
                                    Task { do { try await library.togglePin(project) } catch { library.error = error.localizedDescription } }
                                }
                                Button("Edit", systemImage: "pencil") { editor = project }
                                Button("Delete", systemImage: "trash", role: .destructive) { deleting = project }
                            }
                            if expanded.contains(project.id) || model.selectedProjectID == project.id {
                                let chats = model.conversations.filter { $0.projectID == project.id && $0.deletedAt == nil }.sorted { $0.updatedAt > $1.updatedAt }
                                let visible = Array(chats.prefix(chatLimits[project.id] ?? 5))
                                ForEach(visible) { chat in chatRow(chat).padding(.leading, 28) }
                                if let active = chats.first(where: { $0.id == model.selectedConversationID }), !visible.contains(where: { $0.id == active.id }) {
                                    chatRow(active).padding(.leading, 28)
                                }
                                if chats.count > (chatLimits[project.id] ?? 5) {
                                    Button("Show more") { chatLimits[project.id, default: 5] += 5 }
                                        .font(.caption).padding(.leading, 38).frame(minHeight: 36)
                                }
                            }
                        }
                        .listRowBackground(TBPalette.sidebar)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 16))
                    }
                    if ordered.count > limit {
                        Button("Show more") { limit += 5 }.font(.caption)
                            .listRowBackground(TBPalette.sidebar).listRowSeparator(.hidden)
                    }
                }
            } header: {
                HStack {
                    Button { isExpanded.toggle() } label: {
                        Label("Projects", systemImage: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption.weight(.medium))
                    }.buttonStyle(.plain)
                    Spacer()
                    Button { editor = NativeProject() } label: { Image(systemName: "plus").frame(width: 32, height: 32) }
                        .buttonStyle(.plain).accessibilityLabel("New project").accessibilityIdentifier("newProject")
                }
                .contextMenu { Button("New project", systemImage: "folder.badge.plus") { editor = NativeProject() } }
            }
            .sheet(item: $editor) { project in ProjectEditorView(project: project, library: library) }
            .confirmationDialog("Delete project?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { project in
                Button("Delete project", role: .destructive) {
                    Task { do { try await library.delete(project) } catch { library.error = error.localizedDescription } }
                }
            } message: { _ in Text("Your chats will be kept outside this project.") }
        }
    }
}

struct ProjectGlyph: View {
    let project: NativeProject
    var body: some View {
        if project.icon.isEmpty { Image(systemName: "folder") }
        else { Text(project.icon).accessibilityHidden(true) }
    }
}

struct ProjectEditorView: View {
    @State var project: NativeProject
    let library: ProjectLibrary
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Project name", text: $project.name).accessibilityIdentifier("projectName")
                    TextField("Emoji", text: $project.icon).accessibilityIdentifier("projectEmoji")
                        .onChange(of: project.icon) { _, value in project.icon = String(value.prefix(1)) }
                    TextField("Description", text: $project.description, axis: .vertical).lineLimit(2...4)
                }
                Section {
                    TextEditor(text: $project.instructions).frame(minHeight: 180)
                        .accessibilityLabel("Instructions").accessibilityIdentifier("projectInstructions")
                } header: { Text("Instructions") } footer: {
                    Text("These instructions apply to every chat in this project.")
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .scrollContentBackground(.hidden).background(TBPalette.background)
            .navigationTitle(library.projects.contains(where: { $0.id == project.id }) ? "Edit project" : "New project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        saving = true
                        Task {
                            do { try await library.save(project); dismiss() }
                            catch { self.error = error.localizedDescription }
                            saving = false
                        }
                    }
                    .disabled(saving || project.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("saveProject")
                }
            }
        }
        .tint(TBPalette.brand).presentationDragIndicator(.visible)
    }
}
