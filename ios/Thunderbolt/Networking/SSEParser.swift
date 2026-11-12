/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation

struct SSEFrame: Equatable, Sendable {
    var event: String?
    var data: String
    var id: String?
}

/// Parses Server-Sent Events incrementally, including fields split across network chunks.
struct SSEParser {
    private var buffer: [UInt8] = []
    private var dataLines: [String] = []
    private var eventName: String?
    private var lastEventID: String?
    private var isFirstLine = true

    mutating func append(_ chunk: Data) -> [SSEFrame] {
        buffer.append(contentsOf: chunk)
        return consumeLines(final: false)
    }

    mutating func finish() -> [SSEFrame] {
        consumeLines(final: true)
    }

    private mutating func consumeLines(final: Bool) -> [SSEFrame] {
        var frames: [SSEFrame] = []
        var lineStart = 0
        var index = 0

        while index < buffer.count {
            let byte = buffer[index]
            guard byte == 10 || byte == 13 else {
                index += 1
                continue
            }
            if byte == 13, index + 1 == buffer.count, !final {
                break
            }

            let line = Array(buffer[lineStart..<index])
            let isCRLF = byte == 13 && index + 1 < buffer.count && buffer[index + 1] == 10
            index += isCRLF ? 2 : 1
            lineStart = index
            if let frame = processLine(line) {
                frames.append(frame)
            }
        }

        if final {
            if lineStart < buffer.count {
                let line = Array(buffer[lineStart...])
                if let frame = processLine(line) {
                    frames.append(frame)
                }
            }
            if let frame = dispatchFrame() {
                frames.append(frame)
            }
            buffer.removeAll(keepingCapacity: false)
        } else if lineStart > 0 {
            buffer.removeFirst(lineStart)
        }
        return frames
    }

    private mutating func processLine(_ bytes: [UInt8]) -> SSEFrame? {
        var line = String(decoding: bytes, as: UTF8.self)
        if isFirstLine {
            line = line.replacingOccurrences(of: "\u{feff}", with: "", range: line.startIndex..<line.endIndex)
            isFirstLine = false
        }
        if line.isEmpty {
            return dispatchFrame()
        }
        guard !line.hasPrefix(":") else {
            return nil
        }

        let separator = line.firstIndex(of: ":")
        let field = separator.map { String(line[..<$0]) } ?? line
        var value = separator.map { String(line[line.index(after: $0)...]) } ?? ""
        if value.first == " " {
            value.removeFirst()
        }

        switch field {
        case "data":
            dataLines.append(value)
        case "event":
            eventName = value
        case "id" where !value.contains("\0"):
            lastEventID = value
        default:
            break
        }
        return nil
    }

    private mutating func dispatchFrame() -> SSEFrame? {
        guard !dataLines.isEmpty else {
            eventName = nil
            return nil
        }
        let frame = SSEFrame(event: eventName, data: dataLines.joined(separator: "\n"), id: lastEventID)
        dataLines.removeAll(keepingCapacity: true)
        eventName = nil
        return frame
    }
}
