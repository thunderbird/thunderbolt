/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import XCTest
@testable import Thunderbolt

final class AttachmentStoreTests: XCTestCase {
    func testReferenceHasNoFileBytesAndIsScopedToItsOwner() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AttachmentStore(directory: directory)
        let data = Data("Private attachment fixture".utf8)
        let reference = try await store.store(data, filename: "notes.md", mimeType: nil, owner: "server|alice")
        XCTAssertEqual(reference.mimeType, "text/plain")
        let encoded = try JSONEncoder().encode(reference.part)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("Private attachment"))
        XCTAssertEqual(AttachmentReference(part: reference.part), reference)
        let sameOwner = try await store.load(reference, owner: "server|alice")
        let otherOwner = try await store.load(reference, owner: "server|bob")
        XCTAssertEqual(sameOwner?.bytes, data)
        XCTAssertNil(otherOwner)
        let text = try await store.extractedText(XCTUnwrap(sameOwner))
        XCTAssertEqual(text, "Private attachment fixture")
    }

    func testPathTraversalAndOversizedFilesAreRejected() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AttachmentStore(directory: directory)
        do {
            _ = try await store.load(AttachmentReference(localFileId: "../secret", filename: "x", mimeType: "text/plain"), owner: "account")
            XCTFail("Must not open an arbitrary path")
        } catch AttachmentError.invalidReference {}
        do {
            _ = try await store.store(Data(repeating: 65, count: AttachmentStore.maximumBytes + 1), filename: "large.txt", mimeType: "text/plain", owner: "account")
            XCTFail("Must enforce the attachment size limit")
        } catch AttachmentError.tooLarge {}
    }

    func testFileImportAndPreviewCopyAreOwnerScoped() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        let sourceDirectory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        defer {
            try? FileManager.default.removeItem(at: directory)
            try? FileManager.default.removeItem(at: sourceDirectory)
        }
        try FileManager.default.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)
        let source = sourceDirectory.appending(path: "notes.txt")
        let bytes = Data("Imported from Files.".utf8)
        try bytes.write(to: source)
        let store = AttachmentStore(directory: directory)

        let reference = try await store.importFile(source, owner: "server|alice")
        XCTAssertEqual(reference.filename, "notes.txt")
        XCTAssertEqual(reference.mimeType, "text/plain")
        let preview = try await store.previewURL(reference, owner: "server|alice")
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(preview)), bytes)
        let otherPreview = try await store.previewURL(reference, owner: "server|bob")
        XCTAssertNil(otherPreview)
    }
}
