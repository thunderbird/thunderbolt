/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

/// AI SDK UIMessage stream reducer shared by hosted agents and the on-device engine.
/// Keeps tool/reasoning boundaries and unknown data parts in their original order.
struct UIMessageStreamState {
    private(set) var parts: [ChatContentPart] = []
    private(set) var metadata: ChatJSONValue = .object([:])
    private var indexes: [String: Int] = [:]
    private var toolInputs: [String: String] = [:]

    mutating func consume(_ data: String) throws -> Bool {
        if data == "[DONE]" { return true }
        guard let object = try JSONDecoder().decode(ChatJSONValue.self, from: Data(data.utf8)).objectValue,
              let type = object["type"]?.stringValue else { throw CloudError.invalidResponse }
        switch type {
        case "text-start", "reasoning-start":
            let id = try required("id", in: object)
            let kind = type == "text-start" ? "text" : "reasoning"
            append(.object(["type": .string(kind), "text": .string(""), "state": .string("streaming")]), key: kind + ":" + id)
        case "text-delta", "reasoning-delta":
            let id = try required("id", in: object)
            let kind = type == "text-delta" ? "text" : "reasoning"
            let key = kind + ":" + id
            let delta = try required("delta", in: object)
            try update(key) { fields in fields["text"] = .string((fields["text"]?.stringValue ?? "") + delta) }
        case "text-end", "reasoning-end":
            let id = try required("id", in: object)
            try update((type == "text-end" ? "text:" : "reasoning:") + id) { $0["state"] = .string("done") }
        case "tool-input-start", "tool-input-available":
            let id = try required("toolCallId", in: object)
            let name = try required("toolName", in: object)
            var fields: [String: ChatJSONValue] = ["type": .string("tool-" + name), "toolCallId": .string(id),
                "state": .string(type == "tool-input-start" ? "input-streaming" : "input-available")]
            fields["title"] = object["title"]
            fields["input"] = object["input"]
            append(.object(fields), key: "tool:" + id)
        case "tool-input-delta":
            let id = try required("toolCallId", in: object)
            toolInputs[id, default: ""] += try required("inputTextDelta", in: object)
            let input = toolInputs[id] ?? ""
            try update("tool:" + id) { $0["inputText"] = .string(input) }
        case "tool-output-available", "tool-output-error", "tool-output-denied":
            let id = try required("toolCallId", in: object)
            try update("tool:" + id) { fields in
                fields["state"] = .string(String(type.dropFirst("tool-".count)))
                fields["output"] = object["output"]
                fields["errorText"] = object["errorText"]
            }
        case "message-metadata":
            if let value = object["messageMetadata"] { metadata = Self.merge(metadata, value) }
        case "start":
            if let value = object["messageMetadata"] { metadata = Self.merge(metadata, value) }
        case "finish":
            if let value = object["messageMetadata"] { metadata = Self.merge(metadata, value) }
            return true
        case "error":
            throw CloudError.http(500, object["errorText"]?.stringValue ?? nativeString( "The response could not be completed."))
        case "abort": throw CancellationError()
        default:
            if type.hasPrefix("data-") || type == "source-url" || type == "source-document" || type == "file" {
                if object["transient"]?.boolValue != true {
                    append(.object(object), key: type + ":" + (object["id"]?.stringValue ?? String(parts.count)))
                }
            }
        }
        return false
    }

    private mutating func append(_ raw: ChatJSONValue, key: String) {
        let part = ChatContentPart(rawValue: raw, fallbackID: key)
        if let index = indexes[key] { parts[index] = part }
        else { indexes[key] = parts.count; parts.append(part) }
    }

    private mutating func update(_ key: String, transform: (inout [String: ChatJSONValue]) -> Void) throws {
        guard let index = indexes[key], var fields = parts[index].rawValue.objectValue else { throw CloudError.invalidResponse }
        transform(&fields)
        parts[index] = ChatContentPart(rawValue: .object(fields), fallbackID: key)
    }

    private func required(_ name: String, in fields: [String: ChatJSONValue]) throws -> String {
        guard let value = fields[name]?.stringValue else { throw CloudError.invalidResponse }
        return value
    }

    private static func merge(_ previous: ChatJSONValue, _ incoming: ChatJSONValue) -> ChatJSONValue {
        guard var left = previous.objectValue, let right = incoming.objectValue else { return incoming }
        for (key, value) in right { left[key] = left[key].map { merge($0, value) } ?? value }
        return .object(left)
    }
}
