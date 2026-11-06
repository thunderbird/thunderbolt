# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# A session's public transcript: from the execution file (a JSON array of SDK messages) only the tool calls and their
# results, in order and in the same message shape, for the evidence check in scripts/report.ts. No prompt, no model
# text. A result keeps its first 20,000 characters, a Write call only its path. explore.sh and the explore job both
# run it, so they cannot drift apart.
map(
  select(.type == "assistant" or .type == "user")
  | {type, message: {content: [
      .message.content | arrays | .[]
      | if .type == "tool_use" then
          {type, id, name, input: (if .name == "Write" then {file_path: .input.file_path} else .input end)}
        elif .type == "tool_result" then
          {type, tool_use_id, content: (
            [.content | if type == "string" then . else (arrays | .[] | select(.type == "text") | .text) end]
            | join("\n") | .[0:20000]
          )}
        else empty end
    ]}}
  | select(.message.content != [])
)
