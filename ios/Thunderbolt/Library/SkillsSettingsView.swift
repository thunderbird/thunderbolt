/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct SkillsSettingsView: View {
    @Bindable var library: SkillLibrary
    @State private var selectedSkill: NativeSkill?
    @State private var creatingSkill = false
    @State private var deletingSkill: NativeSkill?
    @State private var search = ""
    @State private var searchVisible = false

    private var filtered: [NativeSkill] {
        library.skills
            .filter { search.isEmpty || $0.displayName.localizedStandardContains(search) || $0.name.localizedStandardContains(search) || $0.description.localizedStandardContains(search) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private var enabledSkills: [NativeSkill] { filtered.filter(\.enabled) }
    private var disabledSkills: [NativeSkill] { filtered.filter { !$0.enabled } }

    var body: some View {
        TBSettingsPage(
            "Skills",
            trailing: AnyView(
                TBSettingsHeaderButton(
                    systemName: searchVisible ? "xmark" : "magnifyingglass",
                    identifier: "searchSkills"
                ) {
                    searchVisible.toggle()
                    if !searchVisible { search = "" }
                }
            )
        ) {
            if searchVisible {
                TextField("Search skills", text: $search)
                    .textInputAutocapitalization(.never)
                    .tbSettingsInputStyle()
                    .accessibilityIdentifier("skillSearch")
            }
            if let error = library.error {
                Text(error)
                    .tbFont(size: 14)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("skillsError")
            }
            if !enabledSkills.isEmpty {
                VStack(spacing: 16) {
                    ForEach(enabledSkills) { skill in skillRow(skill) }
                }
            }
            if !disabledSkills.isEmpty {
                TBSettingsSection(nativeString("Disabled")) {
                    VStack(spacing: 16) {
                        ForEach(disabledSkills) { skill in skillRow(skill) }
                    }
                }
            }
            if filtered.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(search.isEmpty ? "No skills yet" : "No matching skills")
                        .tbFont(size: 16, weight: .semibold)
                        .foregroundStyle(TBPalette.foreground)
                    Text(search.isEmpty ? "Skills are reusable instructions you can call from a chat." : "Try a different search.")
                        .tbFont(size: 14)
                        .foregroundStyle(TBPalette.muted)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
                .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(TBPalette.border, lineWidth: 1))
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HStack {
                Spacer()
                Button {
                    creatingSkill = true
                } label: {
                    Label("New Skill", systemImage: "plus")
                }
                .buttonStyle(TBSettingsPrimaryButtonStyle())
                .accessibilityIdentifier("newSkill")
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 8)
            .background {
                LinearGradient(colors: [TBPalette.background.opacity(0), TBPalette.background], startPoint: .top, endPoint: .center)
                    .ignoresSafeArea(edges: .bottom)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .sheet(item: $selectedSkill) { skill in
            SkillDetailView(skill: skill, library: library)
                .environment(\.tbSettingsSidebarAction, nil)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $creatingSkill) {
            SkillEditorView(skill: NativeSkill(), library: library)
                .environment(\.tbSettingsSidebarAction, nil)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .confirmationDialog("Delete skill?", isPresented: Binding(get: { deletingSkill != nil }, set: { if !$0 { deletingSkill = nil } })) {
            Button("Delete", role: .destructive) {
                guard let skill = deletingSkill else { return }
                perform { try await library.delete(skill) }
                deletingSkill = nil
            }
        } message: {
            Text("This skill will be removed from your library on all synced devices.")
        }
    }

    private func skillRow(_ skill: NativeSkill) -> some View {
        TBSettingsSelectableRow(
            title: skill.displayName,
            subtitle: skill.description.isEmpty ? nil : skill.description,
            trailing: AnyView(
                Toggle("Enable \(skill.displayName)", isOn: Binding(get: { skill.enabled }, set: { value in
                    perform { try await library.setEnabled(skill, value: value) }
                }))
                .labelsHidden()
                .accessibilityIdentifier("skillEnabled-\(skill.name)")
            ),
            accessibilityIdentifier: "skill-\(skill.name)"
        ) {
            selectedSkill = skill
        }
        .contextMenu {
            if !skill.isWidget {
                Button("Edit", systemImage: "pencil") { selectedSkill = skill }
                Button("Delete", systemImage: "trash", role: .destructive) { deletingSkill = skill }
            }
        }
    }

    private func perform(_ action: @escaping @MainActor () async throws -> Void) {
        Task { do { try await action() } catch { library.error = error.localizedDescription } }
    }
}

private struct SkillDetailView: View {
    let skill: NativeSkill
    let library: SkillLibrary
    @Environment(\.dismiss) private var dismiss
    @State private var isEditing = false

    var body: some View {
        TBSettingsPage(
            skill.displayName,
            leading: AnyView(TBSettingsHeaderButton(systemName: "xmark", identifier: "closeSkillDetail") { dismiss() }),
            trailing: skill.isWidget ? nil : AnyView(
                Button("Edit") { isEditing = true }
                    .tbFont(size: 14, weight: .semibold)
                    .foregroundStyle(TBPalette.brand)
                    .accessibilityIdentifier("editSkill")
            )
        ) {
            TBSettingsSection(nativeString("Description")) {
                Text(skill.description.isEmpty ? "No description" : skill.description)
                    .tbFont(size: 16)
                    .foregroundStyle(skill.description.isEmpty ? TBPalette.muted : TBPalette.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Text("/\(skill.name)")
                        .tbFont(size: 14, weight: .medium)
                        .foregroundStyle(TBPalette.brand)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(TBPalette.secondary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    Text(skill.enabled ? "Enabled" : "Disabled")
                        .tbFont(size: 14)
                        .foregroundStyle(TBPalette.muted)
                }
            }
            if !skill.instruction.isEmpty {
                TBSettingsSection(nativeString("Instructions")) {
                    Text(skill.instruction)
                        .tbFont(size: 14)
                        .foregroundStyle(TBPalette.foreground)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .environment(\.tbSettingsSidebarAction, nil)
        .sheet(isPresented: $isEditing) {
            SkillEditorView(skill: skill, library: library)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }
}

struct SkillEditorView: View {
    @State var skill: NativeSkill
    let library: SkillLibrary
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        TBSettingsPage(
            "Edit skill",
            leading: AnyView(TBSettingsHeaderButton(systemName: "xmark", identifier: "cancelSkillEdit") { dismiss() }),
            trailing: AnyView(
                Button("Save") { save() }
                    .tbFont(size: 14, weight: .semibold)
                    .foregroundStyle(TBPalette.brand)
                    .disabled(saving || !SkillLibrary.validName(skill.name) || skill.instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("saveSkill")
            )
        ) {
            if let error {
                Text(error).tbFont(size: 14).foregroundStyle(.red).accessibilityIdentifier("skillEditorError")
            }
            TBSettingsSection(nativeString("Skill")) {
                VStack(alignment: .leading, spacing: 8) {
                    TBSettingsFieldLabel(title: "Name")
                    TextField("Name", text: $skill.label)
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("skillLabel")
                }
                VStack(alignment: .leading, spacing: 8) {
                    TBSettingsFieldLabel(title: "Slug", detail: "Use /\(skill.name.isEmpty ? "slug" : skill.name) in a chat to load these instructions.")
                    TextField("Slug", text: $skill.name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("skillSlug")
                }
                VStack(alignment: .leading, spacing: 8) {
                    TBSettingsFieldLabel(title: "Description")
                    TextField("Description", text: $skill.description, axis: .vertical)
                        .lineLimit(2...4)
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("skillDescription")
                }
            }
            TBSettingsSection(nativeString("Instructions")) {
                TextEditor(text: $skill.instruction)
                    .tbFont(size: 14)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 220)
                    .padding(8)
                    .background(TBPalette.composer, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(TBPalette.border, lineWidth: 1))
                    .accessibilityIdentifier("skillInstructions")
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .disabled(skill.isWidget)
    }

    private func save() {
        saving = true
        Task {
            do {
                try await library.save(skill)
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
            saving = false
        }
    }
}
