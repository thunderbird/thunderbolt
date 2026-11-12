/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import Foundation
import XCTest

enum NativeUITestSupport {
    static func backendLogOffset(file: StaticString = #filePath, line: UInt = #line) -> UInt64 {
        guard let path = ProcessInfo.processInfo.environment["THUNDERBOLT_UI_BACKEND_LOG"],
              let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              let size = attributes[.size] as? NSNumber else {
            XCTFail("The isolated backend log was not provided to the UI test.", file: file, line: line)
            return 0
        }
        return size.uint64Value
    }

    static func stepUpCode(
        after offset: UInt64,
        timeout: TimeInterval = 10,
        file: StaticString = #filePath,
        line: UInt = #line
    ) -> String {
        guard let path = ProcessInfo.processInfo.environment["THUNDERBOLT_UI_BACKEND_LOG"] else {
            XCTFail("The isolated backend log was not provided to the UI test.", file: file, line: line)
            return ""
        }

        let deadline = Date().addingTimeInterval(timeout)
        let pattern = try! NSRegularExpression(pattern: #"\[DEV\] Step-up code: ([0-9]{8})"#)
        while Date() < deadline {
            if let handle = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) {
                defer { try? handle.close() }
                do {
                    try handle.seek(toOffset: offset)
                    if let data = try handle.readToEnd(),
                       let text = String(data: data, encoding: .utf8) {
                        let range = NSRange(text.startIndex..<text.endIndex, in: text)
                        if let match = pattern.firstMatch(in: text, range: range),
                           let codeRange = Range(match.range(at: 1), in: text) {
                            return String(text[codeRange])
                        }
                    }
                } catch {
                    // The backend may still be appending its log line; retry until timeout.
                }
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        XCTFail("Timed out waiting for the isolated backend step-up email code.", file: file, line: line)
        return ""
    }
}
