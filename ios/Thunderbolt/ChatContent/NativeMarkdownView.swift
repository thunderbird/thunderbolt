/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import SwiftUI
import UIKit

struct ChatCitationTarget: Identifiable, Equatable {
    enum Value: Equatable {
        case source(ChatContentSource)
        case document(ChatDocumentReference)
    }

    let value: Value

    var id: String {
        switch value {
        case .source(let source): "source:\(source.id)"
        case .document(let reference): "document:\(reference.id)"
        }
    }
}

struct NativeMarkdownView: View {
    let text: String
    var sources: [ChatContentSource] = []
    var documentReferences: [ChatDocumentReference] = []
    var onCitation: ((ChatCitationTarget) -> Void)?
    private let document: NativeMarkdownDocument

    init(text: String, sources: [ChatContentSource] = [], documentReferences: [ChatDocumentReference] = [],
         onCitation: ((ChatCitationTarget) -> Void)? = nil) {
        self.text = text
        self.sources = sources
        self.documentReferences = documentReferences
        self.onCitation = onCitation
        document = NativeMarkdownParser.document(text)
    }

    @ScaledMetric(relativeTo: .body) private var bodySize = 16.0

    private var blocks: [NativeMarkdownBlock] {
        document.blocks
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(blocks.indices, id: \.self) { index in
                blockView(blocks[index])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .tint(TBPalette.brand)
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "thunderbolt-citation" else {
                if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") {
                    return .systemAction
                }
                return .discarded
            }

            guard let index = Int(url.lastPathComponent) else { return .discarded }
            if url.host == "source", let source = sources.first(where: { $0.index == index }) {
                onCitation?(ChatCitationTarget(value: .source(source)))
                return .handled
            }
            if url.host == "document", let reference = documentReferences.first(where: { $0.position == index }) {
                onCitation?(ChatCitationTarget(value: .document(reference)))
                return .handled
            }
            return .discarded
        })
    }

    @ViewBuilder
    private func blockView(_ block: NativeMarkdownBlock) -> some View {
        switch block {
        case .paragraph(let source):
            inlineContent(source)
                .font(.system(size: bodySize))
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let source):
            inlineContent(source)
                .font(headingFont(level))
                .fixedSize(horizontal: false, vertical: true)
        case .unorderedList(let items):
            listView(items, ordered: false)
        case .orderedList(let items):
            listView(items, ordered: true)
        case .quote(let source):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(TBPalette.brandAmber)
                    .frame(width: 3)
                inlineContent(source)
                    .font(.system(size: bodySize))
                    .foregroundStyle(TBPalette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
        case .code(let language, let source):
            NativeCodeBlockView(language: language, text: source)
        case .table(let headers, let rows):
            tableView(headers: headers, rows: rows)
        case .thematicBreak:
            Rectangle()
                .fill(TBPalette.border)
                .frame(height: 1)
                .padding(.vertical, 3)
        }
    }

    private func listView(_ items: [String], ordered: Bool) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(items.indices, id: \.self) { index in
                let item = items[index]
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    Text(ordered ? "\(index + 1)." : "•")
                        .font(.system(size: bodySize, weight: .medium))
                        .foregroundStyle(TBPalette.muted)
                        .frame(minWidth: ordered ? 24 : 12, alignment: .trailing)
                    inlineContent(item)
                        .font(.system(size: bodySize))
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.leading, 4)
    }

    private func tableView(headers: [String], rows: [[String]]) -> some View {
        let columnCount = max(headers.count, rows.map(\.count).max() ?? 0)
        return ScrollView(.horizontal) {
            VStack(alignment: .leading, spacing: 0) {
                tableRow(headers, columnCount: columnCount, isHeader: true)
                ForEach(rows.indices, id: \.self) { index in
                    tableRow(rows[index], columnCount: columnCount, isHeader: false)
                }
            }
            .fixedSize(horizontal: true, vertical: false)
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(TBPalette.border, lineWidth: 1)
            }
        }
        .scrollIndicators(.hidden)
        .accessibilityLabel("Markdown table")
    }

    private func tableRow(_ cells: [String], columnCount: Int, isHeader: Bool) -> some View {
        HStack(spacing: 0) {
            ForEach(0..<columnCount, id: \.self) { index in
                inlineContent(index < cells.count ? cells[index] : "")
                    .font(isHeader ? .system(.subheadline, weight: .semibold) : .system(.subheadline))
                    .foregroundStyle(TBPalette.foreground)
                    .frame(minWidth: 112, maxWidth: 240, minHeight: 42, alignment: .leading)
                    .padding(.horizontal, 10)
                    .background(isHeader ? TBPalette.secondary : TBPalette.surface)
                    .overlay(alignment: .trailing) {
                        Rectangle().fill(TBPalette.border).frame(width: 0.5)
                    }
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(TBPalette.border).frame(height: 0.5)
                    }
            }
        }
    }

    private func inlineContent(_ source: String) -> some View {
        NativeMathView(source: sourceWithCitationLinks(source), references: document.referenceDefinitions)
    }

    private func sourceWithCitationLinks(_ source: String) -> String {
        guard !sources.isEmpty || !documentReferences.isEmpty,
              let expression = try? NSRegularExpression(pattern: #"\[(\d+)\](?!\()"#) else { return source }
        let value = NSMutableString(string: source)
        let matches = expression.matches(in: source, range: NSRange(location: 0, length: (source as NSString).length))
        for match in matches.reversed() {
            guard let numberRange = Range(match.range(at: 1), in: source),
                  let index = Int(source[numberRange]) else { continue }
            let isSource = sources.contains { $0.index == index }
            let isDocument = documentReferences.contains { $0.position == index }
            guard isSource || isDocument else { continue }
            let kind = isSource ? "source" : "document"
            let citation = (source as NSString).substring(with: match.range)
            value.replaceCharacters(in: match.range, with: "[\(citation)](thunderbolt-citation://\(kind)/\(index))")
        }
        return value as String
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title2.weight(.semibold)
        case 2: .title3.weight(.semibold)
        case 3: .headline
        default: .body.weight(.semibold)
        }
    }
}

private struct NativeCodeBlockView: View {
    let language: String?
    let text: String

    @State private var didCopy = false
    @ScaledMetric(relativeTo: .body) private var bodySize = 15.0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(language?.isEmpty == false ? language! : nativeString( "Code"))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(TBPalette.muted)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Button {
                    UIPasteboard.general.string = text
                    didCopy = true
                } label: {
                    Label(didCopy ? nativeString( "Copied") : nativeString( "Copy"), systemImage: didCopy ? "checkmark" : "doc.on.doc")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(TBPalette.muted)
                .accessibilityLabel(didCopy ? "Copied code" : "Copy code")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(TBPalette.secondary)

            ScrollView(.horizontal) {
                Text(text)
                    .font(.system(size: bodySize, design: .monospaced))
                    .foregroundStyle(TBPalette.foreground)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(12)
            }
            .scrollIndicators(.hidden)
        }
        .background(TBPalette.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(TBPalette.border, lineWidth: 1))
    }
}

struct ChatCitationDetailView: View {
    let target: ChatCitationTarget
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                switch target.value {
                case .source(let source):
                    Section(nativeString( "Source")) {
                        LabeledContent("Title", value: source.title)
                        if let siteName = source.siteName, !siteName.isEmpty {
                            LabeledContent("Website", value: siteName)
                        }
                        if let url = URL(string: source.url), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                            Link(destination: url) {
                                Label(nativeString( "Open source"), systemImage: "arrow.up.right")
                            }
                        }
                    }
                case .document(let reference):
                    Section(nativeString( "Document")) {
                        LabeledContent("File", value: reference.fileName)
                        if let page = reference.pageNumber {
                            LabeledContent("Page", value: String(page))
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(TBPalette.background)
            .navigationTitle(nativeString( "Citation"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(nativeString( "Done")) { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
