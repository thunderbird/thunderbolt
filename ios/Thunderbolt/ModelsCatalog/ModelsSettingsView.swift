/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct ModelsSettingsView: View {
    let library: NativeModelLibrary
    @State private var showingAddModel = false
    @State private var showingSearch = false
    @State private var searchText = ""
    @State private var errorMessage: String?

    private var models: [NativeModel] { library.snapshot?.models ?? [] }
    private var filteredModels: [NativeModel] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return models }
        return models.filter {
            $0.name.localizedCaseInsensitiveContains(query) ||
                $0.provider.localizedCaseInsensitiveContains(query) ||
                $0.model.localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        TBSettingsPage(nativeString("Models"), trailing: AnyView(
            Button {
                withAnimation(.easeInOut(duration: 0.18)) { showingSearch.toggle() }
                if !showingSearch { searchText = "" }
            } label: {
                Image(systemName: showingSearch ? "xmark" : "magnifyingglass")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(TBPalette.foreground)
                    .frame(width: 40, height: 40)
                    .background(TBPalette.surface, in: Circle())
                    .overlay(Circle().stroke(TBPalette.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(nativeString( showingSearch ? "Close search" : "Search models"))
            .accessibilityIdentifier("searchModels")
        )) {
            if showingSearch {
                TextField(nativeString( "Search models"), text: $searchText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .tbSettingsInputStyle()
                    .accessibilityIdentifier("searchModelsField")
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 14))
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("modelCatalogError")
            }
            TBSettingsSection(nativeString("Models"), footer: nativeString( "API keys are stored only on this device. Model settings and profiles sync with your account.")) {
                if filteredModels.isEmpty {
                    Text(nativeString( "No models found"))
                        .font(.system(size: 14))
                        .foregroundStyle(TBPalette.muted)
                } else {
                    ForEach(Array(filteredModels.enumerated()), id: \.element.id) { index, model in
                        if index > 0 { TBSettingsDivider() }
                        modelRow(model)
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Button { showingAddModel = true } label: {
                Label(nativeString( "New Model"), systemImage: "plus")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(TBSettingsPrimaryButtonStyle())
            .accessibilityIdentifier("addModel")
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity)
            .background(TBPalette.background.opacity(0.96))
        }
        .sheet(isPresented: $showingAddModel) {
            AddNativeModelView(library: library)
        }
    }

    @ViewBuilder
    private func modelRow(_ model: NativeModel) -> some View {
        HStack(spacing: 12) {
            NavigationLink {
                NativeModelSettingsDetailView(library: library, model: model)
            } label: {
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(TBPalette.secondary).frame(width: 40, height: 40)
                        Text(String(model.provider.prefix(1)).uppercased())
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(TBPalette.foreground)
                    }
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(model.name)
                                .font(.system(size: 15, weight: .medium))
                                .foregroundStyle(TBPalette.foreground)
                                .lineLimit(1)
                            if model.isConfidential == 1 {
                                Image(systemName: "lock.shield.fill")
                                    .font(.system(size: 12))
                                    .foregroundStyle(TBPalette.brand)
                                    .accessibilityLabel(nativeString( "Confidential model"))
                            }
                        }
                        Text("\(model.provider) · \(model.model)")
                            .font(.system(size: 13))
                            .foregroundStyle(TBPalette.muted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(TBPalette.muted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("model-\(model.id)")

            Toggle(nativeString( "Enabled"), isOn: Binding(
                get: { model.enabled == 1 },
                set: { enabled in
                    Task {
                        do {
                            try await library.repository.setModelEnabled(enabled, id: model.id)
                            try await library.refresh()
                        } catch { errorMessage = error.localizedDescription }
                    }
                }
            ))
            .labelsHidden()
            .tint(TBPalette.brand)
            .accessibilityIdentifier("modelEnabled-\(model.id)")
        }
        .frame(minHeight: 48)
    }
}

private struct AddNativeModelView: View {
    let library: NativeModelLibrary
    @Environment(\.dismiss) private var dismiss
    @State private var provider = "openai"
    @State private var name = ""
    @State private var model = ""
    @State private var url = ""
    @State private var apiKey = ""
    @State private var supportsTools = true
    @State private var contextWindow = ""
    @State private var errorMessage: String?
    @State private var isSaving = false

    var body: some View {
        NavigationStack {
            TBSettingsPage(nativeString("New model"), leading: AnyView(
                Button(nativeString( "Cancel")) { dismiss() }
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(TBPalette.foreground)
                    .accessibilityIdentifier("cancelNewModel")
            ), trailing: AnyView(
                Button(nativeString( "Save")) { save() }
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(TBPalette.brand)
                    .disabled(isSaving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || apiKey.isEmpty || (provider == "custom" && url.isEmpty))
                    .accessibilityIdentifier("saveNewModel")
            )) {
                TBSettingsSection(nativeString("Provider")) {
                    TBSettingsFieldLabel(title: nativeString( "Provider"))
                    Picker("Provider", selection: $provider) {
                        Text("OpenAI").tag("openai")
                        Text("Anthropic").tag("anthropic")
                        Text("OpenRouter").tag("openrouter")
                        Text("Custom OpenAI compatible").tag("custom")
                    }
                    .pickerStyle(.menu)
                    .accessibilityIdentifier("newModelProvider")
                    TextField("Name", text: $name)
                        .textInputAutocapitalization(.words)
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("newModelName")
                    TextField("Model ID", text: $model)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("newModelID")
                    if provider == "custom" {
                        TextField("Base URL", text: $url)
                            .keyboardType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .tbSettingsInputStyle()
                            .accessibilityIdentifier("newModelURL")
                    }
                }
                TBSettingsSection(nativeString("Credentials")) {
                    SecureField("API key", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("newModelAPIKey")
                }
                TBSettingsSection(nativeString("Capabilities")) {
                    Toggle(nativeString( "Use coding tools"), isOn: $supportsTools)
                        .tint(TBPalette.brand)
                    TextField("Context window (optional)", text: $contextWindow)
                        .keyboardType(.numberPad)
                        .tbSettingsInputStyle()
                }
                if let errorMessage {
                    TBSettingsSection(nativeString("Model error")) {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }
            }
            .overlay { if isSaving { ProgressView() } }
        }
        .presentationDetents([.medium, .large])
    }

    private func save() {
        let parsedContext = contextWindow.isEmpty ? nil : Int64(contextWindow)
        guard contextWindow.isEmpty || parsedContext != nil else {
            errorMessage = nativeString( "Enter a valid context window size.")
            return
        }
        isSaving = true
        Task {
            do {
                _ = try await library.repository.addModel(
                    provider: provider, name: name, model: model, url: url,
                    apiKey: apiKey, supportsTools: supportsTools,
                    contextWindow: parsedContext
                )
                try await library.refresh()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSaving = false
            }
        }
    }
}

private struct NativeModelSettingsDetailView: View {
    let library: NativeModelLibrary
    let model: NativeModel
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var modelID: String
    @State private var url: String
    @State private var enabled: Bool
    @State private var supportsTools: Bool
    @State private var supportsParallelToolCalls: Bool
    @State private var contextWindow: String
    @State private var apiKey = ""
    @State private var clearKey = false
    @State private var temperature: String
    @State private var maxSteps: String
    @State private var maxAttempts: String
    @State private var nudgeThreshold: String
    @State private var toolsOverride: String
    @State private var providerOptionsJSON: String
    @State private var errorMessage: String?
    @State private var isSaving = false
    @State private var confirmDelete = false

    init(library: NativeModelLibrary, model: NativeModel) {
        self.library = library
        self.model = model
        let profile = library.snapshot?.profiles[model.id]
        _name = State(initialValue: model.name)
        _modelID = State(initialValue: model.model)
        _url = State(initialValue: model.url ?? "")
        _enabled = State(initialValue: model.enabled == 1)
        _supportsTools = State(initialValue: model.toolUsage == 1)
        _supportsParallelToolCalls = State(initialValue: model.supportsParallelToolCalls == 1)
        _contextWindow = State(initialValue: model.contextWindow.map { String($0) } ?? "")
        _temperature = State(initialValue: profile?.temperature.map { String($0) } ?? "")
        _maxSteps = State(initialValue: profile?.maxSteps.map { String($0) } ?? "")
        _maxAttempts = State(initialValue: profile?.maxAttempts.map { String($0) } ?? "")
        _nudgeThreshold = State(initialValue: profile?.nudgeThreshold.map { String($0) } ?? "")
        _toolsOverride = State(initialValue: profile?.toolsOverride ?? "")
        _providerOptionsJSON = State(initialValue: profile?.providerOptionsJSON ?? "")
    }

    private var isSystem: Bool { model.isSystem == 1 }

    var body: some View {
        TBSettingsPage(model.name, leading: AnyView(
            Button { dismiss() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(TBPalette.foreground)
                    .frame(width: 40, height: 40)
                    .background(TBPalette.surface, in: Circle())
                    .overlay(Circle().stroke(TBPalette.border, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityLabel(nativeString( "Back to models"))
        ), trailing: AnyView(
            Button("Save") { save() }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(TBPalette.brand)
                .disabled(isSaving || isSystem)
                .accessibilityIdentifier("saveModelSettings")
        )) {
            TBSettingsSection(nativeString("Model")) {
                TBSettingsFieldLabel(title: nativeString( "Provider"), detail: model.provider)
                TextField("Name", text: $name).disabled(isSystem).tbSettingsInputStyle()
                TextField("Model ID", text: $modelID).textInputAutocapitalization(.never).disabled(isSystem).tbSettingsInputStyle()
                if model.provider == "custom" {
                    TextField("Base URL", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .disabled(isSystem)
                        .tbSettingsInputStyle()
                }
                Toggle("Enabled", isOn: $enabled).disabled(isSystem).tint(TBPalette.brand)
                Toggle("Use coding tools", isOn: $supportsTools).disabled(isSystem).tint(TBPalette.brand)
                Toggle("Parallel tool calls", isOn: $supportsParallelToolCalls).disabled(isSystem).tint(TBPalette.brand)
                TextField("Context window", text: $contextWindow).keyboardType(.numberPad).disabled(isSystem).tbSettingsInputStyle()
            }
            if !isSystem && model.provider != "thunderbolt" {
                TBSettingsSection(nativeString("API key")) {
                    SecureField("Enter a new API key", text: $apiKey)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .tbSettingsInputStyle()
                        .accessibilityIdentifier("editModelAPIKey")
                        .onChange(of: apiKey) { _, value in
                            if !value.isEmpty { clearKey = false }
                        }
                    if model.apiKey?.isEmpty == false {
                        Text("A key is saved on this device.").font(.system(size: 13)).foregroundStyle(TBPalette.muted)
                        Button("Clear saved key", role: .destructive) { clearKey = true }
                            .frame(minHeight: 40)
                    }
                }
            }
            TBSettingsSection(nativeString("Profile")) {
                TextField("Temperature", text: $temperature).keyboardType(.decimalPad).disabled(isSystem).tbSettingsInputStyle()
                TextField("Maximum steps", text: $maxSteps).keyboardType(.numberPad).disabled(isSystem).tbSettingsInputStyle()
                TextField("Maximum attempts", text: $maxAttempts).keyboardType(.numberPad).disabled(isSystem).tbSettingsInputStyle()
                TextField("Nudge threshold", text: $nudgeThreshold).keyboardType(.numberPad).disabled(isSystem).tbSettingsInputStyle()
                TextField("Provider options JSON", text: $providerOptionsJSON, axis: .vertical)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .lineLimit(2 ... 6)
                    .disabled(isSystem)
                    .tbSettingsInputStyle()
                TextField("Tools override", text: $toolsOverride, axis: .vertical)
                    .lineLimit(4 ... 10)
                    .disabled(isSystem)
                    .tbSettingsInputStyle()
            }
            if !isSystem {
                TBSettingsSection(nativeString("Danger zone")) {
                    Button("Remove model", role: .destructive) { confirmDelete = true }
                        .accessibilityIdentifier("deleteModel")
                }
            }
            if let errorMessage {
                TBSettingsSection(nativeString("Model error")) { Text(errorMessage).foregroundStyle(.red) }
            }
        }
        .overlay { if isSaving { ProgressView() } }
        .confirmationDialog("Remove this model?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Remove model", role: .destructive) { deleteModel() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The model is removed from this device and your synced model list.")
        }
    }

    private func save() {
        let parsedContext = contextWindow.isEmpty ? nil : Int64(contextWindow)
        let parsedTemperature = temperature.isEmpty ? nil : Double(temperature)
        let parsedMaxSteps = maxSteps.isEmpty ? nil : Int64(maxSteps)
        let parsedMaxAttempts = maxAttempts.isEmpty ? nil : Int64(maxAttempts)
        let parsedNudgeThreshold = nudgeThreshold.isEmpty ? nil : Int64(nudgeThreshold)
        guard (contextWindow.isEmpty || parsedContext != nil),
              (temperature.isEmpty || parsedTemperature != nil),
              (maxSteps.isEmpty || parsedMaxSteps != nil),
              (maxAttempts.isEmpty || parsedMaxAttempts != nil),
              (nudgeThreshold.isEmpty || parsedNudgeThreshold != nil) else {
            errorMessage = nativeString( "Check the numeric model and profile settings.")
            return
        }
        isSaving = true
        Task {
            do {
                try await library.repository.saveModelSettings(
                    id: model.id, name: name, model: modelID, url: url,
                    enabled: enabled, supportsTools: supportsTools,
                    supportsParallelToolCalls: supportsParallelToolCalls,
                    contextWindow: parsedContext,
                    profile: NativeModelProfileDraft(
                    temperature: parsedTemperature,
                    maxSteps: parsedMaxSteps,
                    maxAttempts: parsedMaxAttempts,
                    nudgeThreshold: parsedNudgeThreshold,
                    toolsOverride: toolsOverride.isEmpty ? nil : toolsOverride,
                    providerOptionsJSON: providerOptionsJSON.isEmpty ? nil : providerOptionsJSON
                    ),
                    apiKey: apiKey.isEmpty ? nil : apiKey,
                    clearAPIKey: clearKey
                )
                try await library.refresh()
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
                isSaving = false
            }
        }
    }

    private func deleteModel() {
        Task {
            do {
                try await library.repository.softDeleteModel(id: model.id)
                try await library.refresh()
                dismiss()
            } catch { errorMessage = error.localizedDescription }
        }
    }
}
