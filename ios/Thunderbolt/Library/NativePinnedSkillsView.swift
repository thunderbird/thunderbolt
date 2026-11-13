/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct NativePinnedSkillsView: View {
    @Bindable var library: SkillLibrary
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(library.pinned) { skill in
                    Text(skill.displayName).tbFont(size: 16)
                        .foregroundStyle(TBPalette.foreground)
                        .moveDisabled(skill.isWidget || saving)
                        .listRowBackground(TBPalette.surface)
                }
                .onMove { offsets, destination in
                    var ids = library.pinned.map(\.id)
                    ids.move(fromOffsets: offsets, toOffset: destination)
                    saving = true
                    Task {
                        do { try await library.reorderPins(ids); error = nil }
                        catch { self.error = error.localizedDescription }
                        saving = false
                    }
                }
                if let error { Text(error).foregroundStyle(.red).tbFont(size: 14) }
            }
            .environment(\.editMode, .constant(.active))
            .scrollContentBackground(.hidden).background(TBPalette.background)
            .navigationTitle("Reorder pinned skills").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .tint(TBPalette.brand)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
