/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct TasksView: View {
    @Bindable var library: TasksLibrary
    var isEnabled = true

    @State private var isAdding = false
    @State private var isSearching = false
    @State private var newItem = ""
    @State private var editingID: String?
    @State private var editDraft = ""
    @State private var error: String?
    @State private var editMode: EditMode = .inactive

    var body: some View {
        TBSettingsPage(nativeString("Tasks"), scrolling: false, trailing: AnyView(
            TBSettingsHeaderButton(systemName: isSearching ? "xmark" : "magnifyingglass", identifier: "searchTasks") {
                isSearching.toggle()
                if !isSearching { library.searchQuery = "" }
            }.accessibilityLabel(isSearching ? nativeString("Cancel search") : nativeString("Search tasks"))
        )) {
            if !isEnabled {
                ContentUnavailableView("Tasks are off", systemImage: "checklist", description: Text("Turn on Tasks in Preferences to use the shared checklist."))
            } else {
                List {
                    if isSearching {
                        TextField("Search tasks…", text: $library.searchQuery)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .tbSettingsInputStyle()
                            .accessibilityIdentifier("taskSearch")
                            .listRowBackground(TBPalette.background)
                    }

                    if isAdding {
                        Section {
                            HStack {
                                TextField("Add a new task…", text: $newItem, axis: .vertical)
                                    .lineLimit(1...4)
                                    .submitLabel(.done)
                                    .onSubmit { addTask() }
                                    .accessibilityIdentifier("newTaskText")
                                Button("Add", action: addTask)
                                    .disabled(newItem.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                    .accessibilityIdentifier("saveNewTask")
                            }
                        }
                    }

                    if library.visibleTasks.isEmpty {
                        ContentUnavailableView(
                            library.searchQuery.isEmpty ? "No tasks yet" : "No tasks found",
                            systemImage: "checkmark.circle",
                            description: Text(library.searchQuery.isEmpty ? "Add a task to get started." : "Try another search.")
                        )
                    } else {
                        Section {
                            ForEach(library.visibleTasks) { task in
                                taskRow(task)
                                    .tbFont(size: 16)
                                    .padding(.horizontal, 12).padding(.vertical, 10)
                                    .frame(minHeight: 48)
                                    .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 12))
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(TBPalette.border, lineWidth: 1))
                                    .listRowBackground(TBPalette.background)
                                    .listRowSeparator(.hidden)
                                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                                    .swipeActions(edge: .trailing) {
                                        Button("Delete", role: .destructive) { remove(task) }
                                            .accessibilityIdentifier("deleteTask-\(task.id)")
                                    }
                            }
                            .onMove(perform: moveTasks)
                        }
                    }

                    if library.incompleteCount > 50 {
                        Text("Showing 50 of \(library.incompleteCount) tasks")
                            .font(.footnote)
                            .foregroundStyle(TBPalette.muted)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                    if let error {
                        Text(error).font(.subheadline).foregroundStyle(.red)
                            .accessibilityIdentifier("tasksError")
                    }
                    if let libraryError = library.error {
                        Text(libraryError).font(.subheadline).foregroundStyle(.red)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .padding(.top, 8)
                .refreshable {
                    do { try await library.refresh() }
                    catch { self.error = error.localizedDescription }
                }
                .environment(\.editMode, $editMode)
            }
        }
        .background(TBPalette.background)
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom) {
            if isEnabled {
                HStack {
                    Button(editMode == .active ? nativeString("Done") : nativeString("Reorder")) {
                        editMode = editMode == .active ? .inactive : .active
                    }
                    .accessibilityIdentifier("editTasks")
                    Spacer()
                    Button {
                        isAdding.toggle()
                        newItem = ""
                    } label: {
                        Label(isAdding ? nativeString("Cancel") : nativeString("New Task"), systemImage: isAdding ? "xmark" : "plus")
                    }
                    .buttonStyle(TBSettingsPrimaryButtonStyle())
                    .disabled(!library.searchQuery.isEmpty)
                    .accessibilityIdentifier("newTask")
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
                .background(TBPalette.background.opacity(0.95))
            }
        }
        .task { library.start(); try? await library.refresh() }
        .onDisappear { library.stop() }
    }

    @ViewBuilder private func taskRow(_ task: NativeTask) -> some View {
        HStack(spacing: 12) {
            Button {
                Task { await perform { try await library.setComplete(id: task.id, isComplete: true) } }
            } label: {
                Image(systemName: "circle")
                    .font(.title3)
                    .foregroundStyle(TBPalette.muted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Complete \(task.item)")
            .accessibilityIdentifier("completeTask-\(task.id)")

            if editingID == task.id {
                TextField("Task", text: $editDraft, axis: .vertical)
                    .lineLimit(1...4)
                    .submitLabel(.done)
                    .onSubmit { saveEdit(task) }
                    .accessibilityIdentifier("editTaskText-\(task.id)")
                Button("Save") { saveEdit(task) }
                    .accessibilityIdentifier("saveTask-\(task.id)")
            } else {
                Button {
                    editingID = task.id
                    editDraft = task.item
                } label: {
                    Text(task.item)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .foregroundStyle(TBPalette.foreground)
                        .multilineTextAlignment(.leading)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("editTask-\(task.id)")
                Menu {
                    Button("Edit") {
                        editingID = task.id
                        editDraft = task.item
                    }
                    Button("Delete", role: .destructive) { remove(task) }
                } label: {
                    Image(systemName: "ellipsis.circle").foregroundStyle(TBPalette.muted)
                }
                .accessibilityLabel("Task actions for \(task.item)")
            }
        }
        .padding(.vertical, 5)
    }

    private func addTask() {
        let text = newItem
        Task {
            await perform {
                _ = try await library.add(text)
                newItem = ""
                isAdding = false
            }
        }
    }

    private func saveEdit(_ task: NativeTask) {
        Task {
            await perform {
                try await library.updateItem(id: task.id, item: editDraft)
                editingID = nil
                editDraft = ""
            }
        }
    }

    private func remove(_ task: NativeTask) {
        Task { await perform { try await library.delete(id: task.id) } }
    }

    private func moveTasks(from source: IndexSet, to destination: Int) {
        guard library.searchQuery.isEmpty,
              let source = source.first else { return }
        let adjusted = destination > source ? destination - 1 : destination
        Task { await perform { try await library.move(from: source, to: adjusted) } }
    }

    @MainActor private func perform(_ operation: () async throws -> Void) async {
        error = nil
        do { try await operation() }
        catch { self.error = error.localizedDescription }
    }
}
