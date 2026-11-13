/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

enum AttachmentHydrator {
    /// Adds transient model-facing parts. The caller never persists this result;
    /// history sends extracted text while only the latest user turn carries bytes.
    static func parts(for message: ChatMessage, isCurrentTurn: Bool, owner: String?, store: AttachmentStore) async throws -> [ChatContentPart] {
        var parts: [ChatContentPart] = []
        for part in ChatMessageContent(message: message).parts {
            guard let reference = AttachmentReference(part: part) else { parts.append(part); continue }
            parts.append(part)
            guard let owner, let file = try await store.load(reference, owner: owner) else {
                parts.append(text("[Attachment \"\(reference.filename)\" is not available on this device]"))
                continue
            }
            let defaultText = reference.mimeType.hasPrefix("text/") || reference.mimeType == "application/json"
            if !isCurrentTurn || defaultText || reference.deliverAs == "text" {
                let extracted = try await store.extractedText(file)
                parts.append(text("[Attachment: \(reference.filename)]" + (extracted.map { "\n\n" + $0 } ?? "")))
            } else {
                parts.append(ChatContentPart(rawValue: .object([
                    "type": .string("file"), "mediaType": .string(file.reference.mimeType),
                    "filename": .string(file.reference.filename),
                    "url": .string("data:\(file.reference.mimeType);base64,\(file.bytes.base64EncodedString())"),
                ]), fallbackID: "file-" + reference.id))
            }
        }
        return parts
    }

    private static func text(_ value: String) -> ChatContentPart {
        ChatContentPart(rawValue: .object(["type": .string("text"), "text": .string(value)]), fallbackID: "attachment-text")
    }

    static func openAIContent(_ parts: [ChatContentPart]) -> ChatJSONValue {
        providerContent(parts) { part, mime, url in
            if mime.hasPrefix("image/") {
                return .object(["type": .string("image_url"), "image_url": .object(["url": .string(url)])])
            }
            return .object(["type": .string("file"), "file": .object([
                "filename": part.rawValue["filename"] ?? .string("attachment"), "file_data": .string(url),
            ])])
        }
    }

    static func anthropicContent(_ parts: [ChatContentPart]) -> ChatJSONValue {
        providerContent(parts) { _, mime, url in
            let base64 = String(url.split(separator: ",", maxSplits: 1).last ?? "")
            return .object([
                "type": .string(mime.hasPrefix("image/") ? "image" : "document"),
                "source": .object(["type": .string("base64"), "media_type": .string(mime), "data": .string(base64)]),
            ])
        }
    }

    private static func providerContent(_ parts: [ChatContentPart], file: (ChatContentPart, String, String) -> ChatJSONValue) -> ChatJSONValue {
        let content = parts.compactMap { part -> ChatJSONValue? in
            if part.isText { return .object(["type": .string("text"), "text": .string(part.text ?? "")]) }
            guard part.type == "file", let mime = part.rawValue["mediaType"]?.stringValue,
                  let url = part.rawValue["url"]?.stringValue else { return nil }
            return file(part, mime, url)
        }
        if content.allSatisfy({ $0["type"] == .string("text") }) {
            return .string(content.compactMap { $0["text"]?.stringValue }.joined(separator: "\n\n"))
        }
        return .array(content)
    }
}
