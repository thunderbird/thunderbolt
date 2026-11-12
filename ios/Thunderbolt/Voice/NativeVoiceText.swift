/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import Foundation

/// Speech-friendly text cleanup shared by voice chat playback and read-aloud callers.
enum NativeVoiceText {
    private static let widgetAnnouncements: [String: String] = [
        "weather-forecast": "Take a look at the weather forecast on screen.",
        "map": "Take a look at the map on screen.",
        "connect-integration": "Use the connection prompt on screen to continue.",
        "document-result": "See the document on screen.",
        "ask": "Please choose one of the options on screen.",
    ]

    static func toSpeakable(_ input: String) -> String {
        var text = input
        text = replacing(text, pattern: #"<widget:([\w-]+)[\s\S]*?/?>"#) { match in
            guard let range = Range(match.range(at: 1), in: text) else { return " " }
            return " \(widgetAnnouncements[String(text[range]).lowercased()] ?? "") "
        }
        text = replacing(text, pattern: #"<widget:[\s\S]*$"#, with: " ")
        text = replacing(text, pattern: #"【\d+[^】]*】|\[\d+\]"#, with: " ")
        text = replacing(text, pattern: #"```[\s\S]*?```"#, with: " ")
        text = replacing(text, pattern: #"```[\s\S]*$"#, with: " ")
        text = replacing(text, pattern: #"`([^`]*)`"#, template: "$1")
        text = replacing(text, pattern: #"\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]"#, with: " See the equation on screen. ")
        text = replacing(text, pattern: #"\\\([\s\S]*?\\\)|\$(?![\s\d])[^$\n]+\$|\\[a-zA-Z]+\s*(?:\{[^{}]*\})*"#, with: " ")
        text = replacing(text, pattern: #"!\[[^\]]*\]\([^)]*\)"#, with: " ")
        text = replacing(text, pattern: #"\[([^\]]+)\]\([^)]*\)"#, template: "$1")
        text = replacing(text, pattern: #"https?://[^\s)]+"#, with: "link")
        text = replacing(text, pattern: #"(\*\*|__|\*|_|~~)"#, with: "")
        text = replacing(text, pattern: #"(?m)^\s{0,3}#{1,6}\s+|(?m)^\s{0,3}>\s?|(?m)^\s*[-*+]\s+|(?m)^\s*\d+\.\s+"#, with: "")
        text = replacing(text, pattern: #"(?m)^\s*[-*_]{3,}\s*$"#, with: " ")
        text = text.replacingOccurrences(of: "|", with: " ")
        text = text.unicodeScalars.filter {
            !(($0.properties.isEmoji || $0.properties.isEmojiPresentation) &&
              !CharacterSet(charactersIn: "0123456789#*").contains($0))
        }.map(String.init).joined()
        text = text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        text = text.replacingOccurrences(of: #"\s+([.,!?;:])"#, with: "$1", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.rangeOfCharacter(from: .alphanumerics) == nil ? "" : text
    }

    private static func replacing(
        _ input: String,
        pattern: String,
        with replacement: String? = nil,
        template: String? = nil,
        transform: ((NSTextCheckingResult) -> String)? = nil
    ) -> String {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return input }
        let range = NSRange(input.startIndex..., in: input)
        if let replacement { return expression.stringByReplacingMatches(in: input, range: range, withTemplate: replacement) }
        if let template { return expression.stringByReplacingMatches(in: input, range: range, withTemplate: template) }
        guard let transform else { return input }
        let matches = expression.matches(in: input, range: range)
        var output = input
        for match in matches.reversed() {
            guard let swiftRange = Range(match.range, in: output) else { continue }
            output.replaceSubrange(swiftRange, with: transform(match))
        }
        return output
    }
}

/// Streaming counterpart of the shared Tauri sentence/clause aggregator.
struct NativeVoiceSentenceAggregator {
    private static let clausePunctuation: Set<Character> = [",", ";", ":", "—", "–"]
    private static let sentencePunctuation: Set<Character> = [".", "!", "?"]
    private static let abbreviations: Set<String> = [
        "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "inc", "ltd", "co", "eg", "ie", "ph", "approx", "no", "fig", "al",
    ]

    private var buffer = [Character]()
    private var firstEmitted = false

    mutating func push(_ text: String) -> [String] {
        buffer.append(contentsOf: text)
        var chunks = [String]()
        while let boundary = nextBoundary() {
            let chunk = String(buffer[..<boundary]).trimmingCharacters(in: .whitespacesAndNewlines)
            buffer.removeFirst(boundary)
            if !chunk.isEmpty { chunks.append(chunk); firstEmitted = true }
        }
        return chunks
    }

    mutating func flush() -> [String] {
        let rest = String(buffer).trimmingCharacters(in: .whitespacesAndNewlines)
        buffer.removeAll(keepingCapacity: true)
        if rest.isEmpty { return [] }
        firstEmitted = true
        return [rest]
    }

    private func nextBoundary() -> Int? {
        var inCode = false
        var lastWordBreak = -1
        for index in buffer.indices {
            let character = buffer[index]
            if character == "`" { inCode.toggle() }
            if inCode { continue }
            if character.isWhitespace { lastWordBreak = index }
            if !firstEmitted {
                if index + 1 >= 20 {
                    if Self.clausePunctuation.contains(character) { return index + 1 }
                    if let end = sentenceEnd(at: index) { return end }
                }
                if index + 1 >= 48, lastWordBreak > 0 { return lastWordBreak + 1 }
                continue
            }
            if let end = sentenceEnd(at: index) { return end }
        }
        return nil
    }

    private func sentenceEnd(at index: Int) -> Int? {
        guard Self.sentencePunctuation.contains(buffer[index]) else { return nil }
        var end = index
        while end + 1 < buffer.count,
              Self.sentencePunctuation.contains(buffer[end + 1]) || "\")']".contains(buffer[end + 1]) {
            end += 1
        }
        guard end + 1 < buffer.count, buffer[end + 1].isWhitespace else { return nil }
        if buffer[index] == "." {
            if index > 0, index + 1 < buffer.count, buffer[index - 1].isNumber, buffer[index + 1].isNumber { return nil }
            let start = buffer[..<index].lastIndex(where: { !$0.isLetter }).map { $0 + 1 } ?? 0
            let word = String(buffer[start..<index]).lowercased()
            if Self.abbreviations.contains(word) { return nil }
        }
        return end + 1
    }
}
