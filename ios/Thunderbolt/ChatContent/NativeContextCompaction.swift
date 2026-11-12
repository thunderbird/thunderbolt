/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

enum NativeCompactionError: LocalizedError {
    case nothingToCompact, conversationChanged, invalidCheckpoint
    var errorDescription: String? {
        switch self {
        case .nothingToCompact: nativeString("Nothing to compact")
        case .conversationChanged: nativeString("The conversation changed during compaction. Please try again.")
        case .invalidCheckpoint: nativeString("The context summary could not be saved.")
        }
    }
}

enum NativeContextCompaction {
    /// A compaction estimate takes precedence over the pre-compaction provider usage.
    static func contextSize(in metadata: ChatJSONValue?) -> Int64? {
        guard let number = (metadata?["contextTokens"] ?? metadata?["usage"]?["totalTokens"])?.numberValue,
              number.isFinite, number >= 0, number < Double(Int64.max) else { return nil }
        return Int64(number)
    }

    /// Excludes an unanswered user turn and empty stopped response from the checkpoint.
    static func boundary(in messages: [ChatMessage]) -> Int? {
        messages.lastIndex { message in
            guard message.role == .assistant, message.deletedAt == nil else { return false }
            return ChatMessageContent(message: message).parts.contains { part in
                if part.type == "step-start" { return false }
                if part.type == "text" || part.type == "reasoning" { return part.text?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false }
                return true
            }
        }
    }

    static func applying(_ checkpoint: ChatJSONValue, to message: ChatMessage) throws -> ChatMessage {
        guard checkpoint["version"] == .number(1), checkpoint["summary"]?.stringValue != nil,
              checkpoint["retainedTail"]?.arrayValue != nil,
              let tokens = checkpoint["contextTokens"]?.numberValue, tokens >= 0 else {
            throw NativeCompactionError.invalidCheckpoint
        }
        var metadata = message.metadata?.objectValue ?? [:]
        metadata["contextCompaction"] = checkpoint
        metadata["contextTokens"] = .number(tokens)
        var updated = message
        updated.metadata = .object(metadata)
        return updated
    }
}
