/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct NativeContextUsageControl: View {
    @Bindable var model: AppModel
    @State private var presented = false
    @State private var summaryPresented = false
    @State private var summaryRequested = false
    @State private var instructions = ""
    @State private var failed = false
    @Environment(\.locale) private var locale

    private var hasUsage: Bool { model.contextSize != nil && (model.contextWindow ?? 0) > 0 }
    private var progress: Double {
        guard hasUsage, let used = model.contextSize, let maximum = model.contextWindow else { return 0 }
        return min(1, max(0, Double(used) / Double(maximum)))
    }

    var body: some View {
        if hasUsage || (model.supportsContextCompaction && !model.messages.isEmpty) || model.contextSummary != nil {
            Button { failed = false; presented = true } label: {
                Group {
                    if model.isCompacting { ProgressView().controlSize(.small) }
                    else {
                        ZStack {
                            Circle().stroke(TBPalette.border, lineWidth: 2.5)
                            Circle().trim(from: 0, to: progress)
                                .stroke(TBPalette.muted, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                                .rotationEffect(.degrees(-90))
                        }
                        .frame(width: 16, height: 16)
                    }
                }
                .frame(width: 40, height: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(nativeString("Context usage"))
            .accessibilityValue(progress.formatted(.percent.locale(locale)))
            .accessibilityIdentifier("contextUsage")
            .sheet(isPresented: $presented, onDismiss: {
                if summaryRequested { summaryRequested = false; summaryPresented = true }
            }) { usageSheet }
            .sheet(isPresented: $summaryPresented) { summarySheet }
        }
    }

    private var usageSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if hasUsage, let used = model.contextSize, let maximum = model.contextWindow {
                        let usedLabel = used.formatted(.number.notation(.compactName).locale(locale))
                        let maximumLabel = maximum.formatted(.number.notation(.compactName).locale(locale))
                        Text(nativeString("Using \(usedLabel) of \(maximumLabel) Context Window"))
                            .foregroundStyle(TBPalette.muted)
                    }
                    if model.supportsContextCompaction {
                        TextField(nativeString("Add summary instructions (optional)"), text: $instructions, axis: .vertical)
                            .lineLimit(3...6)
                            .padding(12)
                            .background(TBPalette.composer, in: RoundedRectangle(cornerRadius: 16))
                            .disabled(model.isCompacting)
                            .accessibilityLabel(nativeString("Compaction instructions (optional)"))
                            .accessibilityIdentifier("compactionInstructions")
                    } else {
                        Text(nativeString("This model or agent does not offer context compaction."))
                            .foregroundStyle(TBPalette.muted)
                    }
                    if failed {
                        Text(nativeString("Could not compact context. Please try again."))
                            .foregroundStyle(.red).accessibilityIdentifier("compactionError")
                    }
                    if model.contextSummary != nil {
                        Button(nativeString("View summary")) { summaryRequested = true; presented = false }
                            .buttonStyle(.bordered).frame(maxWidth: .infinity)
                            .accessibilityIdentifier("viewContextSummary")
                    }
                    if model.supportsContextCompaction {
                        Button {
                            failed = false
                            Task {
                                let input = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
                                if await model.compactContext(instructions: input.isEmpty ? nil : input) { presented = false }
                                else { failed = true }
                            }
                        } label: {
                            Text(model.isCompacting ? nativeString("Compacting context…") : nativeString("Compact now"))
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(TBSettingsPrimaryButtonStyle())
                        .disabled(model.isStreaming || NativeContextCompaction.boundary(in: model.messages) == nil)
                        .accessibilityIdentifier("compactContext")
                    }
                }
                .tbFont(size: 16)
                .padding(16)
            }
            .background(TBPalette.background)
            .navigationTitle(nativeString("Context usage"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(nativeString("Done")) { presented = false } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private var summarySheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let summary = model.contextSummary?["summary"]?.stringValue {
                        NativeMarkdownView(text: summary)
                    }
                    if let retained = model.contextSummary?["retainedTail"]?.arrayValue, !retained.isEmpty {
                        DisclosureGroup(nativeString("Retained messages")) {
                            ForEach(Array(retained.enumerated()), id: \.offset) { _, message in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(message["role"]?.stringValue ?? "").font(.caption.weight(.semibold))
                                    if let text = message["content"]?.stringValue { NativeMarkdownView(text: text) }
                                    else if let parts = message["content"]?.arrayValue {
                                        ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
                                            if let text = part["text"]?.stringValue { NativeMarkdownView(text: text) }
                                            else if let type = part["type"]?.stringValue { Text(type).foregroundStyle(TBPalette.muted) }
                                        }
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                            }
                        }
                    }
                }
                .padding(16)
            }
            .background(TBPalette.background)
            .navigationTitle(nativeString("Context summary"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button(nativeString("Done")) { summaryPresented = false } } }
        }
    }
}
