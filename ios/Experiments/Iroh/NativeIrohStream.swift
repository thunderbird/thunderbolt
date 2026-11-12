/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import IrohLib

enum NativeIrohError: Error, LocalizedError, Sendable {
    case invalidTarget
    case invalidRelayURL
    case closed
    case invalidUTF8
    case invalidJSONLine
    case messageTooLarge
    case unavailable

    var errorDescription: String? {
        switch self {
        case .invalidTarget: "Enter a valid iroh ticket or node ID."
        case .invalidRelayURL: "The custom iroh relay URL is invalid."
        case .closed: "The iroh connection closed."
        case .invalidUTF8: "The iroh peer sent a message that is not valid UTF-8."
        case .invalidJSONLine: "The iroh peer sent an invalid JSON-RPC message."
        case .messageTooLarge: "The iroh peer sent a message that is too large."
        case .unavailable: "The native iroh transport is unavailable."
        }
    }
}

enum NativeIrohProtocol: String, Sendable, CaseIterable {
    case acp
    case mcp

    var alpn: Data { Data("thunderbolt/\(rawValue)/0".utf8) }
}

struct NativeIrohLineBuffer {
    private let maximumLineBytes: Int
    private var bytes = [UInt8]()

    init(maximumLineBytes: Int = 16 * 1024 * 1024) {
        self.maximumLineBytes = maximumLineBytes
    }

    mutating func append(_ data: Data) throws {
        bytes.append(contentsOf: data)
        guard bytes.count <= maximumLineBytes || bytes.contains(0x0A) else {
            throw NativeIrohError.messageTooLarge
        }
    }

    mutating func takeLine() throws -> String? {
        guard let newline = bytes.firstIndex(of: 0x0A) else {
            guard bytes.count <= maximumLineBytes else { throw NativeIrohError.messageTooLarge }
            return nil
        }
        guard newline <= maximumLineBytes else { throw NativeIrohError.messageTooLarge }
        var line = Array(bytes[..<newline])
        bytes.removeFirst(newline + 1)
        if line.last == 0x0D { line.removeLast() }
        let data = Data(line)
        guard let text = String(data: data, encoding: .utf8) else { throw NativeIrohError.invalidUTF8 }
        guard (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else {
            throw NativeIrohError.invalidJSONLine
        }
        return text
    }

    func finish() throws -> Never {
        if bytes.isEmpty { throw NativeIrohError.closed }
        throw NativeIrohError.invalidJSONLine
    }
}

/// A single iroh bidirectional stream with the same newline-delimited JSON framing as Tauri.
actor NativeIrohStream {
    private static let readChunkBytes: UInt32 = 64 * 1024

    private let connection: Connection
    private let sendStream: SendStream
    private let receiveStream: RecvStream
    private let onClose: @Sendable () async -> Void
    private var lineBuffer = NativeIrohLineBuffer()
    private var isClosed = false

    init(
        connection: Connection,
        stream: BiStream,
        onClose: @escaping @Sendable () async -> Void = {}
    ) {
        self.connection = connection
        sendStream = stream.send()
        receiveStream = stream.recv()
        self.onClose = onClose
    }

    /// Writes one JSON-RPC object and its newline; completion reflects the QUIC stream write.
    func sendLine(_ line: String) async throws {
        guard !isClosed else { throw NativeIrohError.closed }
        guard !line.contains("\n"), !line.contains("\r"),
              let lineData = line.data(using: .utf8),
              lineData.count <= 16 * 1024 * 1024,
              (try? JSONSerialization.jsonObject(with: lineData)) is [String: Any] else {
            throw NativeIrohError.invalidJSONLine
        }
        var frame = lineData
        frame.append(0x0A)
        try await sendStream.writeAll(buf: frame)
    }

    /// Reads and removes one UTF-8 JSON-RPC object terminated by a newline.
    func receiveLine() async throws -> String {
        while true {
            if let line = try lineBuffer.takeLine() { return line }
            guard !isClosed else { throw NativeIrohError.closed }
            let chunk = try await receiveStream.read(sizeLimit: Self.readChunkBytes)
            guard !chunk.isEmpty else { isClosed = true; try lineBuffer.finish() }
            try lineBuffer.append(chunk)
        }
    }

    /// Closes only this peer connection, leaving other streams on the shared endpoint alive.
    func close() async {
        guard !isClosed else { return }
        isClosed = true
        try? connection.close(errorCode: 0, reason: Data("client closed".utf8))
        await onClose()
    }
}
