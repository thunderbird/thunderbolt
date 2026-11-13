/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct NativeWidget: Equatable, Identifiable, Sendable {
    let id: String
    let name: String
    let arguments: [String: String]
}

enum NativeWidgetContentPart: Equatable, Identifiable, Sendable {
    case text(id: String, value: String)
    case widget(NativeWidget)

    var id: String {
        switch self {
        case .text(let id, _): id
        case .widget(let widget): widget.id
        }
    }
}

enum NativeWidgetParser {
    private static let supportedNames: Set<String> = [
        "ask", "citation", "connect-integration", "document-result",
        "link-preview", "map", "weather-forecast"
    ]

    static func parse(_ source: String) -> [NativeWidgetContentPart] {
        let expression = try? NSRegularExpression(
            pattern: #"<([a-z][a-z0-9-]*:[a-z][a-z0-9-]*)\s+((?:[^/]|/(?!>))+)\/>"#,
            options: [.caseInsensitive]
        )
        guard let expression else { return source.isEmpty ? [] : [.text(id: "text-0", value: source)] }
        let nsSource = source as NSString
        let matches = expression.matches(in: source, range: NSRange(location: 0, length: nsSource.length))
        guard !matches.isEmpty else {
            let value = removingIncompleteTrailingTag(source)
            return value.isEmpty ? [] : [.text(id: "text-0", value: value)]
        }

        var result: [NativeWidgetContentPart] = []
        var cursor = 0
        for (index, match) in matches.enumerated() {
            let tagRange = match.range
            let name = nsSource.substring(with: match.range(at: 1)).lowercased()
            let body = nsSource.substring(with: match.range(at: 2))
            if tagRange.location > cursor {
                appendText(nsSource.substring(with: NSRange(location: cursor, length: tagRange.location - cursor)), id: index, to: &result)
            }

            let pieces = name.split(separator: ":", maxSplits: 1).map(String.init)
            if pieces.count == 2, pieces[0] == "widget", supportedNames.contains(pieces[1]) {
                result.append(.widget(NativeWidget(id: "widget-\(index)", name: pieces[1], arguments: parseAttributes(body))))
            }
            cursor = NSMaxRange(tagRange)
        }
        if cursor < nsSource.length {
            appendText(removingIncompleteTrailingTag(nsSource.substring(from: cursor)), id: matches.count, to: &result)
        }
        return result
    }

    private static func removingIncompleteTrailingTag(_ source: String) -> String {
        guard let expression = try? NSRegularExpression(
            pattern: #"<(?:widget:[a-z0-9-]*(?:\s+[^>]*)?|w(?:i(?:d(?:g(?:e(?:t)?)?)?)?)?)?$"#,
            options: [.caseInsensitive]
        ) else { return source }
        let range = NSRange(source.startIndex..<source.endIndex, in: source)
        guard let match = expression.firstMatch(in: source, range: range),
              let start = Range(match.range, in: source) else { return source }
        return String(source[..<start.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func appendText(_ source: String, id: Int, to parts: inout [NativeWidgetContentPart]) {
        let value = source.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        parts.append(.text(id: "text-\(id)", value: value))
    }

    private static func parseAttributes(_ source: String) -> [String: String] {
        let expression = try? NSRegularExpression(pattern: #"([A-Za-z0-9_]+)=([\"'])"#)
        guard let expression else { return [:] }
        let nsSource = source as NSString
        let matches = expression.matches(in: source, range: NSRange(location: 0, length: nsSource.length))
        var attributes: [String: String] = [:]
        for (index, match) in matches.enumerated() {
            let key = nsSource.substring(with: match.range(at: 1))
            let quote = nsSource.substring(with: match.range(at: 2))
            let start = NSMaxRange(match.range)
            let limit = index + 1 < matches.count ? matches[index + 1].range.location : nsSource.length
            guard start <= limit else { continue }
            let end: Int?
            if quote == "\"" {
                let range = nsSource.range(of: "\"", options: [], range: NSRange(location: start, length: limit - start))
                end = range.location == NSNotFound ? nil : range.location
            } else {
                end = closingSingleQuote(in: nsSource, from: start, before: limit)
            }
            guard let end, end >= start else { continue }
            attributes[key] = nsSource.substring(with: NSRange(location: start, length: end - start))
        }
        return attributes
    }

    private static func closingSingleQuote(in source: NSString, from start: Int, before limit: Int) -> Int? {
        var depth = 0
        var inJSONString = false
        var index = start
        while index < limit {
            let character = source.character(at: index)
            if inJSONString {
                if character == 0x5C { index += 2; continue }
                if character == 0x22 { inJSONString = false }
            } else if character == 0x22 {
                inJSONString = true
            } else if character == 0x5B || character == 0x7B {
                depth += 1
            } else if character == 0x5D || character == 0x7D {
                depth -= 1
            } else if character == 0x27 && depth == 0 {
                return index
            }
            index += 1
        }
        return nil
    }
}
