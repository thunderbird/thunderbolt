/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct NativeModelIcon: View {
    let model: NativeModel?
    var size: CGFloat = 18
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if model == nil || model?.requiresServer == true {
                ThunderboltMark(size: size)
            } else if let asset {
                Image(asset).resizable().scaledToFit()
                    .brightness(model?.provider == "tinfoil" && colorScheme == .dark ? 0.25 : 0)
            } else {
                Image(systemName: "server.rack").resizable().scaledToFit()
            }
        }
        .frame(width: size, height: size)
        .foregroundStyle(TBPalette.foreground)
        .accessibilityHidden(true)
    }

    private var asset: String? {
        switch model?.provider {
        case "openai": "ProviderOpenAI"
        case "anthropic": "ProviderAnthropic"
        case "openrouter": "ProviderOpenRouter"
        case "tinfoil": "ProviderTinfoil"
        case "otari": "ProviderOtari"
        default: nil
        }
    }
}

struct NativeModelPicker: View {
    @Bindable var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var effortPosition = 0.0

    private var available: [ChatModel] {
        model.models.filter { !$0.usesHostedAgent && (query.isEmpty || $0.name.localizedStandardContains(query)) }
    }

    var body: some View {
        NavigationStack {
            List {
                if let key = model.selectedConfidentialConnectionKey {
                    Section("Confidential connection") {
                        NativeTinfoilAttestationDetailsView(snapshot: model.attestation.snapshot(for: key))
                            .listRowBackground(TBPalette.surface)
                        Button("Verify connection") { Task { await model.verifyConfidentialConnection() } }
                            .disabled(model.isVerifyingConnection)
                            .accessibilityIdentifier("verifyConfidentialConnection")
                            .listRowBackground(TBPalette.surface)
                    }
                }
                if let reasoning = model.reasoning, !reasoning.capabilities.efforts.isEmpty {
                    Section("Reasoning effort") {
                        VStack(alignment: .leading, spacing: 12) {
                            HStack {
                                Text("Reasoning effort")
                                Spacer()
                                Text(effortLabel(reasoning.preferredEffort)).foregroundStyle(TBPalette.muted)
                            }
                            if reasoning.capabilities.kind == "toggle" {
                                Toggle("Reasoning", isOn: Binding(
                                    get: { reasoning.preferredEffort != "none" },
                                    set: { enabled in
                                        let effort = enabled ? reasoning.capabilities.efforts.first(where: { $0 != "none" }) : "none"
                                        if let effort { Task { await model.saveReasoning(effort) } }
                                    }))
                            } else if reasoning.capabilities.efforts.count > 1 {
                                Slider(value: $effortPosition, in: 0...Double(reasoning.capabilities.efforts.count - 1), step: 1) { editing in
                                    if !editing {
                                        let effort = reasoning.capabilities.efforts[Int(effortPosition)]
                                        Task { await model.saveReasoning(effort) }
                                    }
                                }
                                .accessibilityLabel("Reasoning effort")
                                .accessibilityValue(effortLabel(reasoning.capabilities.efforts[Int(effortPosition)]))
                                .accessibilityIdentifier("reasoningEffort")
                            }
                        }
                        .disabled(model.isSavingReasoning || model.isStreaming)
                        .listRowBackground(TBPalette.surface)
                    }
                }
                if let error = model.reasoningError {
                    Text(error).font(.footnote).foregroundStyle(.red).listRowBackground(TBPalette.surface)
                }
                if available.isEmpty {
                    Text(model.isLoadingModels ? "Loading models…" : "No matching models")
                        .foregroundStyle(TBPalette.muted)
                }
                ForEach(available) { item in
                    let native = model.modelLibrary?.snapshot?.models.first { $0.id == item.id }
                    Button {
                        Task { await model.selectModel(item.id); dismiss() }
                    } label: {
                        HStack(spacing: 12) {
                            NativeModelIcon(model: native, size: 22)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item.name).font(.body.weight(.medium))
                                if let description = native?.description, !description.isEmpty {
                                    Text(description).font(.caption).foregroundStyle(TBPalette.muted).lineLimit(2)
                                }
                            }
                            Spacer(minLength: 4)
                            if native?.isConfidential == 1 {
                                Image(systemName: "lock.shield").foregroundStyle(TBPalette.muted)
                            }
                            if item.id == model.selectedModelID {
                                Image(systemName: "checkmark").foregroundStyle(TBPalette.brand)
                            }
                        }
                        .foregroundStyle(TBPalette.foreground)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isStreaming)
                    .accessibilityLabel(item.name)
                    .accessibilityAddTraits(item.id == model.selectedModelID ? .isSelected : [])
                    .listRowBackground(TBPalette.surface)
                }
                if let library = model.modelLibrary {
                    NavigationLink { ModelsSettingsView(library: library) } label: {
                        Label("Manage models", systemImage: "plus")
                    }
                    .accessibilityIdentifier("manageModelsFromPicker")
                    .listRowBackground(TBPalette.surface)
                }
            }
            .searchable(text: $query, prompt: "Search models")
            .scrollContentBackground(.hidden)
            .background(TBPalette.background)
            .navigationTitle("Model and reasoning effort")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } } }
        }
        .tint(TBPalette.brand)
        .onChange(of: model.reasoning, initial: true) { _, resolution in
            effortPosition = Double(resolution?.capabilities.efforts.firstIndex(of: resolution?.preferredEffort ?? "") ?? 0)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func effortLabel(_ effort: String?) -> String {
        switch effort {
        case "none": nativeString("Off")
        case "minimal": nativeString("Minimal")
        case "low": nativeString("Low")
        case "medium": nativeString("Medium")
        case "high": nativeString("High")
        case "xhigh": nativeString("Extra high")
        case "max": nativeString("Maximum")
        default: nativeString("Model default")
        }
    }
}
