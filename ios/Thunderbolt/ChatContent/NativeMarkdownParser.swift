/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

enum NativeMarkdownBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case unorderedList([String])
    case orderedList([String])
    case quote(String)
    case code(language: String?, text: String)
    case table(headers: [String], rows: [[String]])
    case thematicBreak
}

struct NativeMarkdownDocument: Equatable, Sendable {
    let blocks: [NativeMarkdownBlock]
    let referenceDefinitions: String
}

enum NativeMarkdownInline {
    static func attributed(_ source: String, references: String) -> AttributedString {
        let markdown = references.isEmpty ? source : source + "\n\n" + references
        return (try? AttributedString(markdown: markdown, options: .init(
            interpretedSyntax: references.isEmpty ? .inlineOnlyPreservingWhitespace : .full
        ))) ?? AttributedString(source)
    }
}

enum NativeMarkdownParser {
    static func parse(_ markdown: String) -> [NativeMarkdownBlock] {
        document(markdown).blocks
    }

    static func document(_ markdown: String) -> NativeMarkdownDocument {
        let text = markdown
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        let extracted = extractReferences(text.components(separatedBy: "\n"))
        let lines = extracted.lines
        var blocks: [NativeMarkdownBlock] = []
        var paragraph: [String] = []
        var index = 0

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
            paragraph.removeAll(keepingCapacity: true)
        }

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty else {
                flushParagraph()
                index += 1
                continue
            }

            if let fence = openingFence(trimmed) {
                flushParagraph()
                index += 1
                var codeLines: [String] = []
                while index < lines.count {
                    let current = lines[index]
                    if closesFence(current.trimmingCharacters(in: .whitespaces), fence: fence.marker) {
                        index += 1
                        break
                    }
                    codeLines.append(current)
                    index += 1
                }
                blocks.append(.code(language: fence.language, text: codeLines.joined(separator: "\n")))
                continue
            }

            if let heading = parseHeading(line) {
                flushParagraph()
                blocks.append(.heading(level: heading.level, text: heading.text))
                index += 1
                continue
            }

            if isThematicBreak(trimmed) {
                flushParagraph()
                blocks.append(.thematicBreak)
                index += 1
                continue
            }

            if isTableStart(lines, at: index) {
                flushParagraph()
                let headers = parseTableRow(lines[index])
                index += 2
                var rows: [[String]] = []
                while index < lines.count,
                      !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                      lines[index].contains("|") {
                    rows.append(parseTableRow(lines[index]))
                    index += 1
                }
                blocks.append(.table(headers: headers, rows: rows))
                continue
            }

            if isQuoteLine(line) {
                flushParagraph()
                var quotedLines: [String] = []
                while index < lines.count, isQuoteLine(lines[index]) {
                    quotedLines.append(stripQuote(lines[index]))
                    index += 1
                }
                blocks.append(.quote(quotedLines.joined(separator: "\n")))
                continue
            }

            if let marker = listMarker(line) {
                flushParagraph()
                var items: [String] = []
                let ordered = marker.ordered
                while index < lines.count, let current = listMarker(lines[index]), current.ordered == ordered {
                    items.append(current.content)
                    index += 1
                    while index < lines.count,
                          !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                          listMarker(lines[index]) == nil,
                          lines[index].first?.isWhitespace == true {
                        items[items.count - 1] += "\n" + lines[index].trimmingCharacters(in: .whitespaces)
                        index += 1
                    }
                }
                blocks.append(ordered ? .orderedList(items) : .unorderedList(items))
                continue
            }

            paragraph.append(line)
            index += 1
        }

        flushParagraph()
        return NativeMarkdownDocument(blocks: blocks, referenceDefinitions: extracted.definitions.joined(separator: "\n"))
    }

    /// Foundation validates complete CommonMark definitions, including escaped
    /// URLs and continuation titles. Definitions inside code remain literal.
    private static func extractReferences(_ lines: [String]) -> (lines: [String], definitions: [String]) {
        var visible: [String] = []
        var definitions: [String] = []
        var fence: String?
        var index = 0
        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let current = fence {
                if closesFence(trimmed, fence: current) { fence = nil }
            } else if let opening = openingFence(trimmed) {
                fence = opening.marker
            } else if line.prefix(while: { $0 == " " }).count <= 3,
                      trimmed.hasPrefix("["), trimmed.contains("]:") {
                var count = 0
                for length in 1...min(3, lines.count - index) {
                    let candidate = lines[index..<(index + length)].joined(separator: "\n")
                    if let parsed = try? AttributedString(markdown: candidate), parsed.characters.isEmpty { count = length }
                }
                if count > 0 {
                    definitions.append(lines[index..<(index + count)].joined(separator: "\n"))
                    visible.append("")
                    index += count
                    continue
                }
            }
            visible.append(line)
            index += 1
        }
        return (visible, definitions)
    }

    private static func openingFence(_ line: String) -> (marker: String, language: String?)? {
        guard let first = line.first, first.asciiValue == 96 || first == "~" else { return nil }
        let count = line.prefix(while: { $0 == first }).count
        guard count >= 3 else { return nil }
        let info = line.dropFirst(count).trimmingCharacters(in: .whitespaces)
        return (String(repeating: String(first), count: count), info.isEmpty ? nil : info.components(separatedBy: .whitespaces).first)
    }

    private static func closesFence(_ line: String, fence: String) -> Bool {
        guard let marker = fence.first else { return false }
        let count = line.prefix(while: { $0 == marker }).count
        return count >= fence.count && line.dropFirst(count).allSatisfy(\.isWhitespace)
    }

    private static func parseHeading(_ line: String) -> (level: Int, text: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        let count = trimmed.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(count), trimmed.dropFirst(count).first?.isWhitespace == true else { return nil }
        var title = trimmed.dropFirst(count).trimmingCharacters(in: .whitespaces)
        while title.last == "#" { title.removeLast() }
        return (count, title.trimmingCharacters(in: .whitespaces))
    }

    private static func isThematicBreak(_ line: String) -> Bool {
        let compact = line.filter { !$0.isWhitespace }
        guard compact.count >= 3, let marker = compact.first, marker == "-" || marker == "*" || marker == "_" else { return false }
        return compact.allSatisfy { $0 == marker }
    }

    private static func isTableStart(_ lines: [String], at index: Int) -> Bool {
        guard index + 1 < lines.count,
              lines[index].contains("|"),
              lines[index + 1].contains("|") else { return false }
        let cells = parseTableRow(lines[index + 1])
        return !cells.isEmpty && cells.allSatisfy { cell in
            let value = cell.trimmingCharacters(in: .whitespaces)
            let withoutAlignment = value.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return withoutAlignment.count >= 3 && withoutAlignment.allSatisfy { $0 == "-" }
        }
    }

    private static func parseTableRow(_ line: String) -> [String] {
        var value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|") { value.removeLast() }
        return value.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func isQuoteLine(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix(">")
    }

    private static func stripQuote(_ line: String) -> String {
        var value = line.trimmingCharacters(in: .whitespaces)
        guard value.first == ">" else { return value }
        value.removeFirst()
        if value.first == " " { value.removeFirst() }
        return value
    }

    private static func listMarker(_ line: String) -> (ordered: Bool, content: String)? {
        let value = line.drop(while: { $0 == " " || $0 == "\t" })
        guard let first = value.first else { return nil }
        if (first == "-" || first == "*" || first == "+"), value.dropFirst().first?.isWhitespace == true {
            return (false, String(value.dropFirst().drop(while: \.isWhitespace)))
        }
        let digits = value.prefix(while: \.isNumber)
        guard !digits.isEmpty,
              let marker = value.dropFirst(digits.count).first,
              marker == "." || marker == ")",
              value.dropFirst(digits.count + 1).first?.isWhitespace == true else { return nil }
        return (true, String(value.dropFirst(digits.count + 1).drop(while: \.isWhitespace)))
    }
}
