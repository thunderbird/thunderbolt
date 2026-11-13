/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import IrohLib

/// An exactly-once bridge between a cancellable Swift caller and the non-cancellable iroh-ffi handshake.
final class NativeIrohDialGate<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?
    private var pendingResult: Result<Value, Error>?
    private var wasCancelled = false

    func value() async throws -> Value {
        try await withCheckedThrowingContinuation { continuation in
            lock.lock()
            let result = pendingResult
            if result != nil || wasCancelled {
                pendingResult = nil
                lock.unlock()
                if let result { continuation.resume(with: result) }
                else { continuation.resume(throwing: CancellationError()) }
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }

    func cancel() {
        lock.lock()
        guard !wasCancelled, pendingResult == nil else {
            lock.unlock()
            return
        }
        wasCancelled = true
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(throwing: CancellationError())
    }

    /// Returns false after cancellation so the caller can close the late connection.
    @discardableResult
    func complete(_ result: Result<Value, Error>) -> Bool {
        lock.lock()
        guard !wasCancelled, pendingResult == nil else {
            lock.unlock()
            return false
        }
        let continuation = self.continuation
        if continuation == nil { pendingResult = result }
        self.continuation = nil
        lock.unlock()
        continuation?.resume(with: result)
        return true
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return wasCancelled
    }
}

/// One long-lived endpoint identity shared by ACP and MCP connections.
actor NativeIrohClient {
    static let shared = NativeIrohClient(
        identityStore: KeychainNativeIrohIdentityStore(),
        relayURL: UserDefaults.standard.string(forKey: "thunderbolt.irohRelayURL")
    )

    private let identityStore: any NativeIrohIdentityStoring
    private let relayURL: String?
    private var endpoint: Endpoint?
    private var pendingDials: [UUID: Task<Void, Never>] = [:]
    private var activeConnections: [UUID: Connection] = [:]
    private var isShuttingDown = false

    init(identityStore: any NativeIrohIdentityStoring, relayURL: String? = nil) {
        self.identityStore = identityStore
        self.relayURL = relayURL?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    func nodeID() async throws -> String {
        try await ensureEndpoint().id().description
    }

    func openStream(target: String, protocol bridgeProtocol: NativeIrohProtocol) async throws -> NativeIrohStream {
        guard !isShuttingDown else { throw NativeIrohError.unavailable }
        let endpoint = try await ensureEndpoint()
        try Task.checkCancellation()
        let address = try Self.resolve(target: target)
        let id = UUID()
        let gate = NativeIrohDialGate<NativeIrohStream>()
        let dialTask = Task.detached(priority: .userInitiated) { [weak self] in
            guard let self else {
                gate.complete(.failure(NativeIrohError.unavailable))
                return
            }
            do {
                if gate.isCancelled { await self.finishCancelledDial(id); return }
                let connection = try await endpoint.connect(addr: address, alpn: bridgeProtocol.alpn)
                guard !gate.isCancelled else {
                    try? connection.close(errorCode: 0, reason: Data("dial cancelled".utf8))
                    await self.finishCancelledDial(id)
                    return
                }
                let stream = try await connection.openBi()
                guard !gate.isCancelled else {
                    try? connection.close(errorCode: 0, reason: Data("dial cancelled".utf8))
                    await self.finishCancelledDial(id)
                    return
                }
                let nativeStream = NativeIrohStream(connection: connection, stream: stream) { [weak self] in
                    await self?.releaseConnection(id)
                }
                await self.finishDial(id, connection: connection, stream: nativeStream, gate: gate)
            } catch {
                await self.finishDial(id, error: error, gate: gate)
            }
        }
        pendingDials[id] = dialTask
        return try await withTaskCancellationHandler {
            try await gate.value()
        } onCancel: {
            gate.cancel()
        }
    }

    /// Closes active connections and the endpoint, then waits for canceled FFI dials to unwind.
    func shutdown() async {
        guard !isShuttingDown else { return }
        isShuttingDown = true
        let endpoint = self.endpoint
        for connection in activeConnections.values {
            try? connection.close(errorCode: 0, reason: Data("client shutdown".utf8))
        }
        activeConnections.removeAll()
        if let endpoint { try? await endpoint.close() }
        let dials = Array(pendingDials.values)
        for dial in dials { await dial.value }
        self.endpoint = nil
        isShuttingDown = false
    }

    /// Removes the stable iroh identity after all endpoint and connection work has stopped.
    func clearIdentity() async throws {
        await shutdown()
        try await identityStore.remove()
    }

    private func ensureEndpoint() async throws -> Endpoint {
        if let endpoint { return endpoint }
        guard !isShuttingDown else { throw NativeIrohError.unavailable }
        let secretKey: SecretKey
        if let stored = try await identityStore.load() {
            guard stored.count == 32 else { throw NativeIrohIdentityError.invalidKey }
            secretKey = try SecretKey.fromBytes(bytes: stored)
        } else {
            secretKey = SecretKey.generate()
            try await identityStore.save(secretKey.toBytes())
        }
        let builder = EndpointBuilder()
        builder.applyN0()
        try builder.secretKey(bytes: secretKey.toBytes())
        if let relayURL {
            guard let url = URL(string: relayURL),
                  ["https", "http"].contains(url.scheme?.lowercased() ?? ""),
                  url.host != nil,
                  url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
                throw NativeIrohError.invalidRelayURL
            }
            builder.relayMode(mode: try RelayMode.customFromUrls(urls: [relayURL]))
        }
        let endpoint = try await builder.bind()
        self.endpoint = endpoint
        return endpoint
    }

    private static func resolve(target rawTarget: String) throws -> EndpointAddr {
        let target = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty else { throw NativeIrohError.invalidTarget }
        if let ticket = try? EndpointTicket.fromString(str: target) {
            return ticket.endpointAddr()
        }
        guard let id = try? EndpointId.fromString(s: target) else { throw NativeIrohError.invalidTarget }
        return EndpointAddr(id: id, relayUrl: nil, addresses: [])
    }

    private func finishDial(
        _ id: UUID,
        connection: Connection,
        stream: NativeIrohStream,
        gate: NativeIrohDialGate<NativeIrohStream>
    ) {
        pendingDials.removeValue(forKey: id)
        guard !isShuttingDown, gate.complete(.success(stream)) else {
            try? connection.close(errorCode: 0, reason: Data("dial cancelled".utf8))
            return
        }
        activeConnections[id] = connection
    }

    private func finishDial(_ id: UUID, error: Error, gate: NativeIrohDialGate<NativeIrohStream>) {
        pendingDials.removeValue(forKey: id)
        gate.complete(.failure(error))
    }

    private func finishCancelledDial(_ id: UUID) {
        pendingDials.removeValue(forKey: id)
    }

    private func releaseConnection(_ id: UUID) {
        activeConnections.removeValue(forKey: id)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
