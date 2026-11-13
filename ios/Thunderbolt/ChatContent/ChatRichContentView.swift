/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI

struct ChatRichContentView: View {
    let document: ChatMessageContent
    let role: MessageRole
    var isStreaming = false
    var onAskResponse: ((NativeAskResponse) async throws -> Void)?

    @State private var activeCitation: ChatCitationTarget?

    private var renderItems: [ChatRenderItem] {
        var items: [ChatRenderItem] = []
        var group: [ChatContentPart] = []

        func flushGroup() {
            guard !group.isEmpty else { return }
            items.append(.reasoningGroup(group))
            group.removeAll(keepingCapacity: true)
        }

        for part in document.parts {
            if part.isReasoning || (part.isTool && !isStandaloneArtifact(part)) {
                group.append(part)
                continue
            }

            flushGroup()
            if part.isText, let text = part.text, !text.isEmpty {
                items.append(.text(part, text))
            } else if part.isAttachment {
                items.append(.attachment(part))
            } else if part.isQuote {
                items.append(.quote(part))
            } else if part.isCompaction {
                items.append(.compaction(part))
            } else if isStandaloneArtifact(part) {
                items.append(.artifact(part))
            }
        }
        flushGroup()
        return items
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(renderItems.enumerated()), id: \.offset) { entry in
                render(entry.element)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(item: $activeCitation) { target in
            ChatCitationDetailView(target: target)
        }
    }

    @ViewBuilder
    private func render(_ item: ChatRenderItem) -> some View {
        switch item {
        case .text(_, let text):
            if case .assistant = role {
                NativeAssistantTextContent(
                    text: text,
                    messageID: document.messageID,
                    cache: document.cache,
                    sources: document.metadata.sources,
                    documentReferences: document.metadata.haystackReferences,
                    onCitation: { activeCitation = $0 },
                    onAskResponse: onAskResponse
                )
            } else {
                NativeMarkdownView(text: text)
            }
        case .reasoningGroup(let parts):
            ReasoningToolGroupView(
                parts: parts,
                metadata: document.metadata,
                isStreaming: isStreaming,
                hasResponseText: document.parts.contains(where: { $0.isText && !($0.text?.isEmpty ?? true) })
            )
        case .attachment(let part):
            AttachmentReferenceView(part: part)
        case .quote(let part):
            QuoteReferenceView(part: part)
        case .compaction(let part):
            CompactionNoticeView(part: part)
        case .artifact(let part):
            SandboxedArtifactView(part: part)
        }
    }

    private func isStandaloneArtifact(_ part: ChatContentPart) -> Bool {
        guard part.isRenderHTML else { return false }
        if part.state == "output-error" { return false }
        if part.state == "output-available" { return part.hasVerifiedArtifactOutput }
        return true
    }
}

private struct NativeAssistantTextContent: View {
    let text: String
    let messageID: String
    let cache: ChatJSONValue?
    let sources: [ChatContentSource]
    let documentReferences: [ChatDocumentReference]
    let onCitation: (ChatCitationTarget) -> Void
    let onAskResponse: ((NativeAskResponse) async throws -> Void)?

    private var contentParts: [NativeWidgetContentPart] { NativeWidgetParser.parse(text) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(contentParts) { part in
                switch part {
                case .text(_, let value):
                    NativeMarkdownView(
                        text: value,
                        sources: sources,
                        documentReferences: documentReferences,
                        onCitation: onCitation
                    )
                case .widget(let widget):
                    NativeWidgetView(
                        widget: widget,
                        messageID: messageID,
                        sources: sources,
                        cache: cache,
                        onAskResponse: onAskResponse
                    )
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private enum ChatRenderItem: Identifiable {
    case text(ChatContentPart, String)
    case reasoningGroup([ChatContentPart])
    case attachment(ChatContentPart)
    case quote(ChatContentPart)
    case compaction(ChatContentPart)
    case artifact(ChatContentPart)

    var id: String {
        switch self {
        case .text(let part, _): "text:\(part.id)"
        case .reasoningGroup(let parts): "group:\(parts.map(\.id).joined(separator: ":"))"
        case .attachment(let part): "attachment:\(part.id)"
        case .quote(let part): "quote:\(part.id)"
        case .compaction(let part): "compaction:\(part.id)"
        case .artifact(let part): "artifact:\(part.id)"
        }
    }
}

private struct ReasoningToolGroupView: View {
    let parts: [ChatContentPart]
    let metadata: ChatContentMetadata
    let isStreaming: Bool
    let hasResponseText: Bool

    @State private var isExpanded = false

    private var toolParts: [ChatContentPart] { parts.filter(\.isTool) }
    private var reasoningParts: [ChatContentPart] { parts.filter(\.isReasoning) }
    private var hasActivePart: Bool {
        parts.contains { part in
            if part.isReasoning { return part.state == "streaming" }
            return part.isTool && part.state != "output-available" && part.state != "output-error" && part.state != "output-denied"
        }
    }

    private var title: String {
        if let activeTool = toolParts.last(where: { $0.state != "output-available" && $0.state != "output-error" }) {
            return displayName(for: activeTool)
        }
        if hasActivePart { return nativeString( "Thinking…") }
        if !toolParts.isEmpty {
            return nativeString( "Completed \(toolParts.count) steps")
        }
        return nativeString( "Thought")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            DisclosureGroup(isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(parts.enumerated()), id: \.offset) { entry in
                        let part = entry.element
                        if part.isReasoning {
                            reasoningRow(part)
                        } else if part.isTool {
                            ToolStepView(part: part, displayName: displayName(for: part))
                        }
                    }
                }
                .padding(.top, 4)
            } label: {
                HStack(spacing: 9) {
                    if hasActivePart && isStreaming {
                        ProgressView().controlSize(.small)
                    } else {
                        Image(systemName: "checkmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(TBPalette.muted)
                    }
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(TBPalette.muted)
                    if !toolParts.isEmpty {
                        Text("\(toolParts.count)")
                            .font(.caption)
                            .foregroundStyle(TBPalette.muted)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(TBPalette.secondary, in: Capsule())
                    }
                }
                .frame(minHeight: 36, alignment: .leading)
                .contentShape(Rectangle())
            }
            .tint(TBPalette.muted)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(TBPalette.surface.opacity(0.82), in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(TBPalette.border, lineWidth: 0.8))

            if isStreaming && !hasResponseText,
               let current = reasoningParts.last,
               let text = current.text,
               !text.isEmpty {
                ScrollView {
                    Text(text)
                        .font(.subheadline)
                        .foregroundStyle(TBPalette.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 200)
                .padding(.horizontal, 12)
                .accessibilityLabel("Current reasoning")
            }
        }
    }

    private func reasoningRow(_ part: ChatContentPart) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Image(systemName: "brain")
                .foregroundStyle(TBPalette.muted)
            Text(part.text ?? nativeString( "Thinking"))
                .font(.subheadline)
                .foregroundStyle(TBPalette.foreground)
                .textSelection(.enabled)
        }
        .padding(.vertical, 6)
    }

    private func displayName(for part: ChatContentPart) -> String {
        guard let rawName = part.toolName, !rawName.isEmpty else { return nativeString( "Tool") }
        if let server = metadata.mcpTools[rawName] {
            return "\(server.name) · \(server.toolName)"
        }
        return rawName
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }
}

private struct ToolStepView: View {
    let part: ChatContentPart
    let displayName: String

    @State private var isExpanded = false

    private var status: String {
        switch part.state {
        case "input-streaming", "input-available": nativeString( "Running")
        case "approval-requested": nativeString( "Approval needed")
        case "output-error": nativeString( "Failed")
        case "output-denied": nativeString( "Denied")
        case "output-available": nativeString( "Completed")
        default: nativeString( "Waiting")
        }
    }

    private var detail: String? {
        if let output = part.output { return output.prettyPrintedString }
        if let input = part.input { return input.prettyPrintedString }
        return nil
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(TBPalette.muted)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(10)
                    .background(TBPalette.background, in: RoundedRectangle(cornerRadius: 10))
                    .padding(.top, 6)
            }
        } label: {
            HStack(spacing: 9) {
                if status == nativeString( "Running") {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: status == nativeString( "Failed") ? "exclamationmark.circle" : "wrench.and.screwdriver")
                        .foregroundStyle(TBPalette.muted)
                }
                Text(displayName)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(TBPalette.foreground)
                    .lineLimit(1)
                Spacer(minLength: 6)
                Text(status)
                    .font(.caption)
                    .foregroundStyle(TBPalette.muted)
            }
            .frame(minHeight: 34)
            .contentShape(Rectangle())
        }
        .tint(TBPalette.muted)
        .padding(.horizontal, 10)
        .background(TBPalette.background.opacity(0.65), in: RoundedRectangle(cornerRadius: 11))
    }
}

private struct AttachmentReferenceView: View {
    let part: ChatContentPart

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: iconName)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(TBPalette.brand)
                .frame(width: 40, height: 40)
                .background(TBPalette.secondary, in: RoundedRectangle(cornerRadius: 11))
            VStack(alignment: .leading, spacing: 3) {
                Text(part.attachmentFilename ?? nativeString( "Attachment"))
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(TBPalette.foreground)
                    .lineLimit(2)
                Text(part.attachmentMIMEType ?? nativeString( "File"))
                    .font(.caption)
                    .foregroundStyle(TBPalette.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 14))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(TBPalette.border, lineWidth: 0.8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(nativeString( "Attachment: \(part.attachmentFilename ?? nativeString( "File"))"))
    }

    private var iconName: String {
        let mimeType = part.attachmentMIMEType?.lowercased() ?? ""
        if mimeType.hasPrefix("image/") { return "photo" }
        if mimeType == "application/pdf" { return "doc.richtext" }
        return "paperclip"
    }
}

private struct QuoteReferenceView: View {
    let part: ChatContentPart

    var body: some View {
        if let text = part.quoteText, !text.isEmpty {
            HStack(spacing: 9) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(TBPalette.brand)
                    .frame(width: 3)
                Text(text)
                    .font(.subheadline)
                    .foregroundStyle(TBPalette.muted)
                    .lineLimit(5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .padding(11)
            .background(TBPalette.secondary.opacity(0.6), in: RoundedRectangle(cornerRadius: 12))
            .accessibilityLabel(nativeString( "Quoted text: \(text)"))
        }
    }
}

private struct CompactionNoticeView: View {
    let part: ChatContentPart
    @State private var isExpanded = false

    private var status: String {
        part.data?["status"]?.stringValue ?? nativeString( "Context updated")
    }

    private var summary: String {
        part.data?["summary"]?.arrayValue?.compactMap { $0["text"]?.stringValue }.joined(separator: "\n") ?? ""
    }

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            if !summary.isEmpty {
                Text(summary)
                    .font(.subheadline)
                    .foregroundStyle(TBPalette.foreground)
                    .textSelection(.enabled)
                    .padding(.top, 5)
            }
            if let error = part.data?["error"]?.stringValue, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        } label: {
            Label(status.replacingOccurrences(of: "_", with: " ").capitalized, systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(TBPalette.muted)
                .frame(minHeight: 34, alignment: .leading)
        }
        .tint(TBPalette.muted)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 12))
    }
}
