/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import XCTest
@testable import Thunderbolt

final class NativeMCPTransportTests: XCTestCase {
    override func tearDown() {
        MCPStubURLProtocol.handler = nil
        MCPStubURLProtocol.requests.removeAll()
        super.tearDown()
    }

    func testStreamableHTTPListsToolsAndUsesSessionHeaders() async throws {
        MCPStubURLProtocol.handler = { request in
            let object = try Self.bodyObject(request)
            let method = object["method"] as? String
            if method == "initialize" {
                return (Self.response(id: object["id"]!, result: ["protocolVersion": "2025-03-26", "capabilities": [:]]), 200, ["Mcp-Session-Id": "session-1"])
            }
            if method == "notifications/initialized" { return (Data(), 202, [:]) }
            if method == "tools/list" {
                return (Self.response(id: object["id"]!, result: [
                    "tools": [["name": "lookup", "description": "Looks things up", "inputSchema": ["type": "object"]]],
                ]), 200, [:])
            }
            return (Data(), 200, [:])
        }

        let client = NativeMCPClient(session: Self.makeSession())
        let tools = try await client.listTools(
            serverURL: URL(string: "https://mcp.example.org/api/mcp")!, transport: "http", bearerToken: "secret"
        )

        XCTAssertEqual(tools.map { $0.name }, ["lookup"])
        let requests = MCPStubURLProtocol.requests
        XCTAssertEqual(requests.compactMap { (try? Self.bodyObject($0))?["method"] as? String }, [
            "initialize", "notifications/initialized", "tools/list",
        ])
        XCTAssertEqual(requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "Mcp-Session-Id"), "session-1")
        XCTAssertEqual(requests.last?.value(forHTTPHeaderField: "MCP-Protocol-Version"), "2025-03-26")
    }

    func testMcpProtocolErrorsAndUnsafeURLsAreRejected() async throws {
        MCPStubURLProtocol.handler = { request in
            let object = try Self.bodyObject(request)
            if object["method"] as? String == "initialize" {
                return (Self.response(id: object["id"]!, result: ["protocolVersion": "2025-03-26", "capabilities": [:]]), 200, [:])
            }
            if object["method"] as? String == "notifications/initialized" { return (Data(), 202, [:]) }
            return (Self.response(id: object["id"]!, error: ["code": -32601, "message": "Unknown method"]), 200, [:])
        }
        let client = NativeMCPClient(session: Self.makeSession())
        do {
            _ = try await client.callTool(
                serverURL: URL(string: "https://mcp.example.org/mcp")!, transport: "http", bearerToken: nil,
                name: "missing", arguments: [:]
            )
            XCTFail("Expected the MCP error response to fail the call")
        } catch let error as NativeMCPError {
            XCTAssertEqual(error, .protocolError(-32601, "Unknown method"))
        }
        do {
            _ = try await client.listTools(
                serverURL: URL(string: "http://public.example.org/mcp")!, transport: "http", bearerToken: "secret"
            )
            XCTFail("Public HTTP must not receive credentials")
        } catch let error as NativeMCPError {
            XCTAssertEqual(error, .invalidURL)
        }
    }

    func testToolResultPreservesContentAndServerIsErrorFlag() async throws {
        MCPStubURLProtocol.handler = { request in
            let object = try Self.bodyObject(request)
            if object["method"] as? String == "initialize" {
                return (Self.response(id: object["id"]!, result: ["protocolVersion": "2025-03-26", "capabilities": [:]]), 200, [:])
            }
            if object["method"] as? String == "notifications/initialized" { return (Data(), 202, [:]) }
            return (Self.response(id: object["id"]!, result: [
                "content": [["type": "text", "text": "tool rejected the input"]], "isError": true,
            ]), 200, [:])
        }
        let client = NativeMCPClient(session: Self.makeSession())

        let result = try await client.callTool(
            serverURL: URL(string: "https://mcp.example.org/mcp")!, transport: "http", bearerToken: nil,
            name: "lookup", arguments: ["query": .string("bad input")]
        )

        XCTAssertEqual(result.isError, true)
        XCTAssertEqual(result.content?.first?["text"]?.stringValue, "tool rejected the input")
    }

    func testToolDescriptorsMatchTauriPrefixCollisionAndMetadataContract() {
        let schema = ChatJSONValue.object(["type": .string("object")])
        let servers = [
            NativeMCPServer(id: "1", name: "Render", type: .http, url: "https://one.example/mcp", enabled: true, credentialType: nil),
            NativeMCPServer(id: "2", name: "Render", type: .http, url: "https://two.example/mcp", enabled: true, credentialType: nil),
            NativeMCPServer(id: "3", name: "Render 2", type: .http, url: "https://three.example/mcp", enabled: true, credentialType: nil),
        ]
        let tool = NativeMCPTool(name: "search", title: nil, description: "Search", inputSchema: schema)
        let descriptors = NativeMCPLibrary.makeToolDescriptors(
            servers: servers,
            toolsByServer: ["1": [tool], "2": [tool], "3": [tool]]
        )

        XCTAssertEqual(descriptors.map(\.name), ["render_search", "render_2_search", "render_2_2_search"])
        XCTAssertEqual(descriptors.map(\.serverURL), servers.map(\.url))
        XCTAssertEqual(descriptors.map(\.toolName), ["search", "search", "search"])
        XCTAssertTrue(descriptors.allSatisfy { $0.inputSchema == schema })
    }

    private static func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MCPStubURLProtocol.self]
        return URLSession(configuration: configuration)
    }

    private static func bodyObject(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let body = request.httpBody { data = body }
        else if let stream = request.httpBodyStream { data = try read(stream) }
        else { return [:] }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    fileprivate static func read(_ stream: InputStream) throws -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 1024)
        defer { buffer.deallocate() }
        while true {
            let count = stream.read(buffer, maxLength: 1024)
            if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeContentData) }
            if count == 0 { return data }
            data.append(buffer, count: count)
        }
    }

    private static func response(id: Any, result: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "result": result])) ?? Data()
    }

    private static func response(id: Any, error: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "error": error])) ?? Data()
    }
}

private final class MCPStubURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Data, Int, [String: String]))?
    nonisolated(unsafe) static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let request = try Self.requestWithBody(request)
            Self.requests.append(request)
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (data, status, headers) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }

    override func stopLoading() {}

    private static func requestWithBody(_ request: URLRequest) throws -> URLRequest {
        guard request.httpBody == nil, let stream = request.httpBodyStream else { return request }
        let data = try NativeMCPTransportTests.read(stream)
        var normalized = request
        normalized.httpBodyStream = nil
        normalized.httpBody = data
        return normalized
    }
}
