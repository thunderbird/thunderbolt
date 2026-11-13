/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

enum NativeACPStreamEvent: Sendable, Equatable {
    case text(String)
    case reasoning(String)
    case toolCall(id: String, title: String?, input: ChatJSONValue?)
    case toolCallUpdate(id: String, title: String?, input: ChatJSONValue?, status: String?, output: ChatJSONValue?)
    case modeChanged(String)
    case configOptionsChanged(ChatJSONValue)
}

/// Converts ACP's incremental session updates into stable chat-runtime events.
/// The original JSON remains available for fields added by newer ACP agents.
enum NativeACPUpdateTranslator {
    static func translate(_ update: ChatJSONValue) -> [NativeACPStreamEvent] {
        switch update["sessionUpdate"]?.stringValue {
        case "agent_message_chunk":
            guard update["content"]?["type"]?.stringValue == "text",
                  let text = update["content"]?["text"]?.stringValue else { return [] }
            return [.text(text)]
        case "agent_thought_chunk":
            guard update["content"]?["type"]?.stringValue == "text",
                  let text = update["content"]?["text"]?.stringValue else { return [] }
            return [.reasoning(text)]
        case "tool_call":
            guard let id = update["toolCallId"]?.identifierString else { return [] }
            return [.toolCall(id: id, title: update["title"]?.stringValue, input: update["rawInput"])]
        case "tool_call_update":
            guard let id = update["toolCallId"]?.identifierString else { return [] }
            return [.toolCallUpdate(
                id: id, title: update["title"]?.stringValue, input: update["rawInput"],
                status: update["status"]?.stringValue,
                output: update["rawOutput"] ?? update["content"]
            )]
        case "current_mode_update":
            guard let mode = update["currentModeId"]?.stringValue else { return [] }
            return [.modeChanged(mode)]
        case "config_option_update":
            guard let options = update["configOptions"] else { return [] }
            return [.configOptionsChanged(options)]
        default:
            return []
        }
    }
}
