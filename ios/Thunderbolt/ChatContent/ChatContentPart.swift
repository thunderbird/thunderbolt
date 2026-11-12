/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

/// JSON value used at the persisted UIMessage boundary so newer part types survive older clients.
enum ChatJSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([ChatJSONValue])
    case object([String: ChatJSONValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([ChatJSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: ChatJSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    subscript(_ key: String) -> ChatJSONValue? {
        guard case .object(let values) = self else { return nil }
        return values[key]
    }

    var stringValue: String? {
        guard case .string(let value) = self else { return nil }
        return value
    }

    var identifierString: String? {
        switch self {
        case .string(let value): value
        case .number(let value): String(value)
        case .bool(let value): String(value)
        case .null, .array, .object: nil
        }
    }

    var boolValue: Bool? {
        guard case .bool(let value) = self else { return nil }
        return value
    }

    var numberValue: Double? {
        guard case .number(let value) = self else { return nil }
        return value
    }

    var arrayValue: [ChatJSONValue]? {
        guard case .array(let value) = self else { return nil }
        return value
    }

    var objectValue: [String: ChatJSONValue]? {
        guard case .object(let value) = self else { return nil }
        return value
    }

    var prettyPrintedString: String {
        guard let data = try? JSONEncoder.pretty.encode(self),
              let value = String(data: data, encoding: .utf8) else { return "" }
        return value
    }
}

fileprivate extension JSONEncoder {
    static var pretty: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}

/// One persisted AI SDK `UIMessage` part. `rawValue` retains all fields for lossless re-encoding.
struct ChatContentPart: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let type: String
    let rawValue: ChatJSONValue

    init(rawValue: ChatJSONValue, fallbackID: String) {
        self.rawValue = rawValue
        self.type = rawValue["type"]?.stringValue ?? "unknown"
        self.id = rawValue["id"]?.identifierString
            ?? rawValue["toolCallId"]?.identifierString
            ?? fallbackID
    }

    init(from decoder: Decoder) throws {
        let rawValue = try ChatJSONValue(from: decoder)
        self.init(rawValue: rawValue, fallbackID: Self.stableFallbackID(for: rawValue))
    }

    private static func stableFallbackID(for rawValue: ChatJSONValue) -> String {
        let data = (try? JSONEncoder.pretty.encode(rawValue)) ?? Data()
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in data {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return String(format: "part-%016llx", hash)
    }

    func encode(to encoder: Encoder) throws {
        try rawValue.encode(to: encoder)
    }

    var text: String? { rawValue["text"]?.stringValue }
    var state: String? { rawValue["state"]?.stringValue }
    var toolCallID: String? { rawValue["toolCallId"]?.stringValue }
    var input: ChatJSONValue? { rawValue["input"] }
    var output: ChatJSONValue? { rawValue["output"] }
    var data: ChatJSONValue? { rawValue["data"] }
    var title: String? { rawValue["title"]?.stringValue }
    var isTool: Bool { type == "dynamic-tool" || type.hasPrefix("tool-") }
    var isReasoning: Bool { type == "reasoning" }
    var isText: Bool { type == "text" }
    var isAttachment: Bool { type == "data-attachment" }
    var isQuote: Bool { type == "data-quote" }
    var isCompaction: Bool { type == "data-acp-compaction" }

    var toolName: String? {
        if type == "dynamic-tool" { return rawValue["toolName"]?.stringValue }
        guard type.hasPrefix("tool-") else { return nil }
        return String(type.dropFirst("tool-".count))
    }

    var isRenderHTML: Bool { toolName == "render_html" }
    var artifactTitle: String { input?["title"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? nativeString( "Artifact") }
    var artifactHTML: String? { input?["html"]?.stringValue }

    /// The UI SDK may wrap a tool result in a `details` object or a textual JSON block.
    var hasVerifiedArtifactOutput: Bool {
        guard isRenderHTML else { return false }
        if output?["ok"]?.boolValue == true || output?["details"]?["ok"]?.boolValue == true {
            return true
        }
        guard let content = output?["content"]?.arrayValue else { return false }
        for item in content where item["type"]?.stringValue == "text" {
            guard let text = item["text"]?.stringValue,
                  let data = text.data(using: .utf8),
                  let value = try? JSONDecoder().decode(ChatJSONValue.self, from: data) else { continue }
            if value["ok"]?.boolValue == true { return true }
        }
        return false
    }

    var attachmentFilename: String? { data?["filename"]?.stringValue }
    var attachmentMIMEType: String? { data?["mimeType"]?.stringValue }
    var attachmentLocalID: String? { data?["localFileId"]?.stringValue }
    var quoteText: String? { data?["text"]?.stringValue }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

struct ChatContentSource: Codable, Equatable, Identifiable, Sendable {
    let index: Int
    let title: String
    let url: String
    let siteName: String?
    let favicon: String?
    let allowRemoteImages: Bool?

    var id: String { "\(index):\(url)" }
}

struct ChatDocumentReference: Codable, Equatable, Identifiable, Sendable {
    let position: Int
    let fileID: String
    let fileName: String
    let pageNumber: Int?

    var id: String { "\(position):\(fileID):\(fileName):\(pageNumber ?? 0)" }
}

struct ChatMCPToolMetadata: Codable, Equatable, Sendable {
    let name: String
    let url: String
    let toolName: String
}

struct ChatContentMetadata: Codable, Equatable, Sendable {
    let modelID: String?
    let sources: [ChatContentSource]
    let haystackReferences: [ChatDocumentReference]
    let mcpTools: [String: ChatMCPToolMetadata]

    init(rawValue: ChatJSONValue = .object([:])) {
        self.modelID = rawValue["modelId"]?.stringValue
        self.sources = rawValue["sources"]?.arrayValue?.compactMap { value in
            guard let index = value["index"]?.intValue,
                  let title = value["title"]?.stringValue,
                  let url = value["url"]?.stringValue else { return nil }
            return ChatContentSource(
                index: index,
                title: title,
                url: url,
                siteName: value["siteName"]?.stringValue,
                favicon: value["favicon"]?.stringValue,
                allowRemoteImages: value["allowRemoteImages"]?.boolValue
            )
        } ?? []
        self.haystackReferences = rawValue["haystackReferences"]?.arrayValue?.compactMap { value in
            guard let position = value["position"]?.intValue,
                  let fileID = value["fileId"]?.stringValue,
                  let fileName = value["fileName"]?.stringValue else { return nil }
            return ChatDocumentReference(
                position: position,
                fileID: fileID,
                fileName: fileName,
                pageNumber: value["pageNumber"]?.intValue
            )
        } ?? []
        self.mcpTools = rawValue["mcpTools"]?.objectValue?.reduce(into: [:]) { result, pair in
            guard let name = pair.value["name"]?.stringValue,
                  let url = pair.value["url"]?.stringValue,
                  let toolName = pair.value["toolName"]?.stringValue else { return }
            result[pair.key] = ChatMCPToolMetadata(name: name, url: url, toolName: toolName)
        } ?? [:]
    }

    init(from decoder: Decoder) throws {
        self.init(rawValue: try ChatJSONValue(from: decoder))
    }

    func encode(to encoder: Encoder) throws {
        var fields: [String: ChatJSONValue] = [:]
        if let modelID { fields["modelId"] = .string(modelID) }
        if !sources.isEmpty {
            fields["sources"] = .array(sources.map { source in
                .object([
                    "index": .number(Double(source.index)),
                    "title": .string(source.title),
                    "url": .string(source.url),
                    "siteName": source.siteName.map(ChatJSONValue.string) ?? .null,
                    "favicon": source.favicon.map(ChatJSONValue.string) ?? .null,
                    "allowRemoteImages": source.allowRemoteImages.map(ChatJSONValue.bool) ?? .null,
                ])
            })
        }
        if !haystackReferences.isEmpty {
            fields["haystackReferences"] = .array(haystackReferences.map { reference in
                .object([
                    "position": .number(Double(reference.position)),
                    "fileId": .string(reference.fileID),
                    "fileName": .string(reference.fileName),
                    "pageNumber": reference.pageNumber.map { .number(Double($0)) } ?? .null,
                ])
            })
        }
        if !mcpTools.isEmpty {
            fields["mcpTools"] = .object(mcpTools.mapValues { tool in
                .object(["name": .string(tool.name), "url": .string(tool.url), "toolName": .string(tool.toolName)])
            })
        }
        try ChatJSONValue.object(fields).encode(to: encoder)
    }
}

struct ChatMessageContent: Equatable, Sendable {
    let messageID: String
    let parts: [ChatContentPart]
    let metadata: ChatContentMetadata
    let cache: ChatJSONValue?

    init(parts: [ChatContentPart], metadata: ChatContentMetadata = ChatContentMetadata(), messageID: String = "", cache: ChatJSONValue? = nil) {
        self.messageID = messageID
        self.parts = parts.enumerated().map { index, part in
            ChatContentPart(rawValue: part.rawValue, fallbackID: "part-\(index)")
        }
        self.metadata = metadata
        self.cache = cache
    }

    init(message: ChatMessage) {
        self.messageID = message.id
        self.cache = message.cache
        let decodedParts = message.parts ?? []
        if decodedParts.isEmpty, !message.text.isEmpty {
            self.parts = [ChatContentPart(
                rawValue: .object(["type": .string("text"), "text": .string(message.text)]),
                fallbackID: "legacy-text"
            )]
        } else {
            self.parts = decodedParts.enumerated().map { index, part in
                ChatContentPart(rawValue: part.rawValue, fallbackID: "part-\(index)")
            }
        }
        self.metadata = ChatContentMetadata(rawValue: message.metadata ?? .object([:]))
    }

    /// Decodes the JSON columns used by the Tauri chat_messages table.
    /// If parts are absent or unreadable, older content-only rows remain visible.
    init(partsData: Data?, metadataData: Data? = nil, legacyText: String = "") {
        self.messageID = ""
        self.cache = nil
        let decoder = JSONDecoder()
        let rawParts = partsData.flatMap { try? decoder.decode([ChatJSONValue].self, from: $0) } ?? []
        let parsedParts = rawParts.enumerated().map { index, raw in
            ChatContentPart(rawValue: raw, fallbackID: "part-\(index)")
        }
        let rawMetadata = metadataData.flatMap { try? decoder.decode(ChatJSONValue.self, from: $0) } ?? .object([:])
        self.metadata = ChatContentMetadata(rawValue: rawMetadata)
        self.parts = parsedParts.isEmpty && !legacyText.isEmpty
            ? [ChatContentPart(
                rawValue: .object(["type": .string("text"), "text": .string(legacyText)]),
                fallbackID: "legacy-text"
            )]
            : parsedParts
    }
}

private extension ChatJSONValue {
    var intValue: Int? {
        guard case .number(let value) = self, value.isFinite, value.rounded() == value else { return nil }
        return Int(exactly: value)
    }
}
