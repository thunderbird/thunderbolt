/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct ChatView: View {
    @Bindable var model: AppModel
    @State private var historyPresented = false
    @State private var settingsSection = false
    @State private var destination: NativeDestination?
    @State private var isAtBottom = true
    @State private var isUserScrolling = false
    @State private var editingProject: NativeProject?
    @State private var modelPickerPresented = false
    @State private var creatingSkill = false
    @State private var reorderingSkills = false
    @FocusState private var composerFocused: Bool
    @ScaledMetric(relativeTo: .body) private var bodySize = 16.0

    var body: some View {
        SideDrawer(isPresented: $historyPresented) {
            if let destination {
                NavigationStack {
                    NativeDestinationView(destination: destination, model: model)
                        .environment(\.tbSettingsSidebarAction, { historyPresented = true })
                }
                .id(destination)
            } else {
              VStack(spacing: 0) {
                header
                Group {
                    if model.messages.isEmpty {
                        emptyChat
                    } else {
                        messageHistory.id(model.selectedConversationID)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            .background(TBPalette.background)
            }
        } sidebar: {
            HistoryView(model: model, settingsSection: $settingsSection, destination: destination,
                onNavigate: { destination = $0; historyPresented = false }) {
                    destination = nil
                    historyPresented = false
                }
        }
        .task { await model.refreshModels() }
        .task(id: model.selectedModelID) { await model.loadReasoning() }
        .sheet(item: $editingProject) { project in
            if let library = model.projectLibrary { ProjectEditorView(project: project, library: library) }
        }
        .sheet(isPresented: $reorderingSkills) {
            if let library = model.skillLibrary { NativePinnedSkillsView(library: library) }
        }
        .sheet(isPresented: $creatingSkill) {
            if let library = model.skillLibrary {
                SkillEditorView(skill: NativeSkill(), library: library)
                    .environment(\.tbSettingsSidebarAction, nil)
                    .presentationDetents([.large])
            }
        }
        .sheet(isPresented: $modelPickerPresented) { NativeModelPicker(model: model) }
        .onChange(of: historyPresented) { _, presented in
            if presented { composerFocused = false }
        }
        .onDisappear { Task { await model.stopVoice() } }
    }

    private var header: some View {
        HStack(spacing: 0) {
            Button {
                TBHaptics.selection()
                historyPresented = true
            } label: {
                Image(systemName: "sidebar.left")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(TBPalette.foreground)
                    .frame(width: 48, height: 48)
                    .background(glassBackground(in: Circle()))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Toggle Sidebar")
            .accessibilityIdentifier("openHistory")

            Spacer(minLength: 8)
            if let project = model.currentProject {
                Button { editingProject = project } label: {
                    HStack(spacing: 6) {
                        ProjectGlyph(project: project)
                        Text(project.name).font(.subheadline.weight(.medium)).lineLimit(1)
                    }
                    .padding(.horizontal, 12).frame(height: 40)
                    .background(glassBackground(in: Capsule()))
                }
                .buttonStyle(.plain).accessibilityLabel("Project settings").accessibilityIdentifier("projectBadge")
                Spacer(minLength: 8)
            }
            agentMenu
            if model.messages.isEmpty && model.currentProject == nil {
                Spacer(minLength: 8)
                Color.clear.frame(width: 48, height: 48)
                    .accessibilityHidden(true)
            }
        }
        .frame(height: 56)
        .padding(.horizontal, 8)
    }

    private var agentMenu: some View {
        Menu {
            if let builtIn = model.models.first(where: { !$0.usesHostedAgent }) {
                Button {
                    if model.selectedModel?.usesHostedAgent != false {
                        Task { await model.selectModel(builtIn.id) }
                    }
                } label: {
                    Label("Thunderbolt", systemImage: model.selectedModel?.usesHostedAgent == false ? "checkmark" : "bolt")
                }
            }
            ForEach(model.models.filter(\.usesHostedAgent)) { agent in
                Button {
                    Task { await model.selectModel(agent.id) }
                } label: {
                    Label(agent.name, systemImage: model.selectedModelID == agent.id ? "checkmark" : "cloud")
                }
            }
        } label: {
            if model.messages.isEmpty && model.currentProject == nil {
                HStack(spacing: 7) {
                    ThunderboltMark(size: 18)
                    Text(model.selectedModel?.usesHostedAgent == true ? (model.selectedModel?.name ?? nativeString("Thunderbolt")) : nativeString("Thunderbolt"))
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(TBPalette.foreground)
                        .lineLimit(1)
                }
                .padding(.horizontal, 13)
                .frame(height: 48)
                .background(glassBackground(in: Capsule()))
            } else {
                ThunderboltMark(size: 22)
                    .frame(width: 48, height: 48)
                    .background(glassBackground(in: Circle()))
            }
        }
        .buttonStyle(.plain)
        .disabled(model.isStreaming || model.models.isEmpty)
        .accessibilityLabel("Choose agent")
        .accessibilityIdentifier("agentPicker")
    }

    @ViewBuilder
    private func glassBackground<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26.0, *) {
            Color.clear.glassEffect(.regular, in: shape)
        } else {
            shape
                .fill(.ultraThinMaterial)
                .overlay(shape.stroke(TBPalette.border.opacity(0.45), lineWidth: 0.5))
        }
    }

    private var emptyChat: some View {
        VStack(spacing: 16) {
            Spacer(minLength: 16)
            ThunderboltMark(size: 72, opacity: 0.62)
            greeting
                .font(.custom("MozillaHeadline-Medium", size: 24, relativeTo: .title2))
                .foregroundStyle(TBPalette.muted)
                .accessibilityIdentifier("emptyGreeting")
            chatErrorNotice
            Spacer(minLength: 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { composerFocused = false }
    }

    @ViewBuilder
    private var greeting: some View {
        let hour = Calendar.current.component(.hour, from: .now)
        if hour < 5 {
            Text("Up late?")
        } else if hour < 12 {
            Text("Good morning")
        } else if hour < 18 {
            Text("Good afternoon")
        } else {
            Text("Good evening")
        }
    }

    private var messageHistory: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    ForEach(model.messages) { message in
                        MessageRow(message: message, model: model)
                            .id(message.id)
                    }
                    if model.isStreaming || (model.statusText?.isEmpty == false) {
                        HStack(spacing: 8) {
                            if model.isStreaming { ProgressView().controlSize(.small) }
                            Text(model.statusText ?? nativeString("Thinking…"))
                                .font(.caption)
                                .foregroundStyle(TBPalette.muted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                    }
                    chatErrorNotice
                    Color.clear.frame(height: 1).id("chatBottom")
                }
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 16)
                .padding(.top, 20)
                .padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.interactively)
            .task {
                isUserScrolling = false
                await Task.yield()
                proxy.scrollTo("chatBottom", anchor: .bottom)
                isAtBottom = true
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 80
            } action: { _, atBottom in
                if isUserScrolling { isAtBottom = atBottom }
            }
            .onScrollPhaseChange { _, phase in
                isUserScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
            }
            .onChange(of: model.messages.count) { _, _ in
                let userInitiated = model.messages.last?.role == .user
                scrollToLatest(using: proxy, userInitiated: userInitiated, animated: userInitiated)
            }
            .onChange(of: model.messages.last?.text) { _, _ in
                scrollToLatest(using: proxy, userInitiated: false, animated: false)
            }
            .onChange(of: model.messages.last?.parts) { _, _ in
                scrollToLatest(using: proxy, userInitiated: false, animated: false)
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 0) {
                if !model.draftAttachments.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(model.draftAttachments) { reference in
                                AttachmentCard(reference: reference, model: model) { model.removeDraftAttachment(reference.id) }
                            }
                        }
                    }
                    .padding(.bottom, 8)
                }
                if let error = model.attachmentError {
                    HStack(alignment: .top) {
                        Text(error).font(.caption).foregroundStyle(.red)
                        Spacer(minLength: 4)
                        Button("Dismiss", systemImage: "xmark") { model.attachmentError = nil }
                            .labelStyle(.iconOnly).font(.caption)
                    }.padding(.bottom, 8)
                }
                skillSuggestions
                TextField(
                    "Ask me anything…",
                    text: $model.draft,
                    prompt: Text("Ask me anything…").foregroundStyle(TBPalette.muted),
                    axis: .vertical
                )
                    .lineLimit(1...6)
                    .font(.system(size: bodySize))
                    .frame(minHeight: 54, alignment: .topLeading)
                    .focused($composerFocused)
                    .submitLabel(.send)
                    .onSubmit(sendMessage)
                    .accessibilityIdentifier("composer")

                HStack(spacing: 8) {
                    AttachmentPickerButton(model: model)
                    NativeContextUsageControl(model: model)
                    Spacer(minLength: 0)
                    if model.selectedModel?.usesHostedAgent != true { modelMenu }
                    if model.isStreaming {
                        Button { Task { await model.stop() } } label: {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 14, weight: .semibold))
                                .frame(width: 40, height: 40)
                        }
                        .buttonStyle(TBPrimaryButtonStyle())
                        .accessibilityLabel("Stop response")
                        .accessibilityIdentifier("stopResponse")
                    } else if model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                              model.draftAttachments.isEmpty, model.authConfiguration?.minimalMode != true {
                        Button {
                            composerFocused = false
                            Task { await model.startVoice() }
                        } label: {
                            Image(systemName: "waveform")
                                .font(.system(size: 18, weight: .medium))
                                .frame(width: 40, height: 40)
                        }
                        .buttonStyle(TBPrimaryButtonStyle())
                        .disabled(model.selectedModel == nil || model.isLoadingModels || model.isImportingAttachments || model.isSaving)
                        .accessibilityLabel("Start voice mode")
                        .accessibilityIdentifier("startVoiceMode")
                    } else {
                        Button(action: sendMessage) {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 16, weight: .semibold))
                                .frame(width: 40, height: 40)
                        }
                        .buttonStyle(TBPrimaryButtonStyle())
                        .disabled(
                            (model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.draftAttachments.isEmpty) ||
                                model.selectedModel == nil || model.isLoadingModels || model.isImportingAttachments || model.isSaving
                        )
                        .accessibilityLabel("Send message")
                        .accessibilityIdentifier("sendMessage")
                    }
                }
            }
            .padding(8)
            .background(TBPalette.composer, in: RoundedRectangle(cornerRadius: 24))
            .overlay {
                RoundedRectangle(cornerRadius: 24)
                    .stroke(composerFocused ? TBPalette.border : .clear, lineWidth: 1)
            }
            .allowsHitTesting(model.voiceSession == nil)
            .accessibilityHidden(model.voiceSession != nil)
            .overlay {
                if let voice = model.voiceSession {
                    NativeVoiceComposer(state: voice.state, error: voice.lastError, inputLevel: voice.inputLevel) {
                        Task { await model.stopVoice() }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .shadow(color: TBPalette.foreground.opacity(0.045), radius: 16, y: 3)
            .overlay(alignment: .topLeading) {
                if model.messages.isEmpty, model.voiceSession == nil, model.authConfiguration?.minimalMode != true {
                    pinnedSkills.offset(y: -48)
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .background(TBPalette.background.opacity(0.97))
    }

    private var modelMenu: some View {
        Button { TBHaptics.selection(); modelPickerPresented = true } label: {
            HStack(spacing: 5) {
                NativeModelIcon(model: model.modelLibrary?.snapshot?.models.first { $0.id == model.selectedModelID }, size: 15)
                Text(model.selectedModel?.name ?? nativeString("Choose model"))
                    .font(.footnote.weight(.medium))
                    .lineLimit(1)
                    .foregroundStyle(TBPalette.foreground)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(TBPalette.muted)
            }
            .padding(.horizontal, 8)
            .frame(height: 40)
            .background(TBPalette.secondary.opacity(0.55), in: RoundedRectangle(cornerRadius: 14))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Model")
        .accessibilityIdentifier("modelPicker")
    }

    @ViewBuilder
    private var pinnedSkills: some View {
        let pinned = model.skillLibrary?.pinned ?? []
        let pinnable = (model.skillLibrary?.enabled ?? []).filter { $0.pinnedOrder == nil && !$0.isWidget }
        if !pinned.isEmpty || !pinnable.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(pinned) { skill in
                        Button {
                            insertPinnedSkill(skill)
                        } label: {
                            Text(skill.displayName).tbFont(size: 14).lineLimit(1)
                            .foregroundStyle(TBPalette.foreground)
                            .padding(.horizontal, 12)
                            .frame(minHeight: 40)
                            .background(TBPalette.secondary.opacity(0.65), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Insert /\(skill.name)")
                        .accessibilityIdentifier("pinnedSkill-\(skill.name)")
                        .contextMenu {
                            Button("Add to chat", systemImage: "plus") { insertPinnedSkill(skill) }
                            Button("Add instructions to chat", systemImage: "doc.text") {
                                model.draft += (model.draft.isEmpty ? "" : "\n\n") + skill.instruction
                                composerFocused = true
                            }
                            Button("Reorder", systemImage: "list.number") { reorderingSkills = true }
                            if !skill.isWidget {
                                Button("Unpin", systemImage: "pin.slash") {
                                    Task {
                                        do { try await model.skillLibrary?.togglePin(skill) }
                                        catch { model.chatError = error.localizedDescription }
                                    }
                                }
                            }
                        }
                    }
                    Menu {
                        ForEach(pinnable) { skill in
                            Button(skill.displayName) {
                                Task {
                                    do { try await model.skillLibrary?.togglePin(skill) }
                                    catch { model.chatError = error.localizedDescription }
                                }
                            }
                        }
                        Button("New skill", systemImage: "plus") {
                            creatingSkill = true
                        }
                    } label: {
                        Image(systemName: "plus").font(.system(size: 18))
                            .foregroundStyle(TBPalette.foreground).frame(width: 40, height: 40)
                            .background(TBPalette.secondary.opacity(0.65), in: Circle())
                    }
                    .disabled(pinned.count >= 10)
                    .accessibilityLabel("Add a skill")
                    .accessibilityIdentifier("addPinnedSkill")
                }
            }
            .frame(height: 40)
        }
    }

    @ViewBuilder
    private var skillSuggestions: some View {
        if let query = slashSkillQuery {
            let matches = (model.skillLibrary?.enabled ?? [])
                .filter { $0.name.hasPrefix(query.value) }
                .prefix(6)
            if !matches.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(matches)) { skill in
                            Button {
                                completeSlashSkill(skill, replacing: query.range)
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(skill.displayName).font(.caption.weight(.semibold)).lineLimit(1)
                                    Text("/\(skill.name)").font(.system(.caption2, design: .monospaced)).lineLimit(1)
                                }
                                .foregroundStyle(TBPalette.foreground)
                                .padding(.horizontal, 10)
                                .frame(minHeight: 42, alignment: .leading)
                                .background(TBPalette.secondary.opacity(0.7), in: RoundedRectangle(cornerRadius: 12))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Insert /\(skill.name)")
                            .accessibilityIdentifier("skillSuggestion-\(skill.name)")
                        }
                    }
                }
                .padding(.bottom, 8)
                .accessibilityIdentifier("skillSuggestions")
            }
        }
    }

    private var slashSkillQuery: (range: Range<String.Index>, value: String)? {
        let start = model.draft.lastIndex(where: \.isWhitespace).map { model.draft.index(after: $0) } ?? model.draft.startIndex
        let range = start..<model.draft.endIndex
        let token = model.draft[range]
        guard token.first == "/" else { return nil }
        let query = token.dropFirst()
        guard query.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { return nil }
        return (range, String(query))
    }

    private func insertPinnedSkill(_ skill: NativeSkill) {
        if model.draft.isEmpty || model.draft.last?.isWhitespace == true {
            model.draft += "/\(skill.name) "
        } else {
            model.draft += " /\(skill.name) "
        }
        composerFocused = true
    }

    private func completeSlashSkill(_ skill: NativeSkill, replacing range: Range<String.Index>) {
        model.draft.replaceSubrange(range, with: "/\(skill.name) ")
        composerFocused = true
    }

    @ViewBuilder
    private var chatErrorNotice: some View {
        if let error = model.chatError, !error.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(error).font(.subheadline)
                Button("Try again") {
                    Task { await model.recoverFromChatError() }
                }
                .font(.subheadline.weight(.semibold))
                .disabled(model.isStreaming || model.isLoadingModels)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(TBPalette.brandAmber.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))
            .accessibilityIdentifier("chatError")
        }
    }

    private func scrollToLatest(using proxy: ScrollViewProxy, userInitiated: Bool, animated: Bool) {
        guard isAtBottom || userInitiated else { return }
        isAtBottom = true
        guard animated else {
            proxy.scrollTo("chatBottom", anchor: .bottom)
            return
        }
        withAnimation(.easeOut(duration: 0.22)) {
            proxy.scrollTo("chatBottom", anchor: .bottom)
        }
    }

    private func sendMessage() {
        composerFocused = false
        Task { await model.send() }
    }
}

private struct MessageRow: View {
    let message: ChatMessage
    let model: AppModel
    @ScaledMetric(relativeTo: .body) private var bodySize = 16.0

    var body: some View {
        Group {
            if message.role == .user {
                VStack(alignment: .trailing, spacing: 8) {
                    ForEach((message.parts ?? []).compactMap(AttachmentReference.init(part:))) { reference in
                        AttachmentCard(reference: reference, model: model)
                    }
                    if !message.text.isEmpty {
                        Text(message.text)
                        .textSelection(.enabled)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .background(TBPalette.secondary.opacity(0.6), in: RoundedRectangle(cornerRadius: 20))
                    }
                }
                .containerRelativeFrame(.horizontal, alignment: .trailing) { width, _ in width * 0.75 }
                .frame(maxWidth: .infinity, alignment: .trailing)
                .contextMenu {
                    if !message.text.isEmpty {
                        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
                    }
                }
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    ChatRichContentView(document: ChatMessageContent(message: message), role: message.role,
                        isStreaming: model.isStreaming && model.messages.last?.id == message.id,
                        onAskResponse: { try await model.respondToAsk($0) })
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !message.text.isEmpty, !(model.isStreaming && model.messages.last?.id == message.id) {
                        MessageCopyButton(text: message.text, messageID: message.id)
                    }
                }
            }
        }
        .font(.system(size: bodySize))
        .lineSpacing(4)
        .foregroundStyle(TBPalette.foreground)
    }

}
