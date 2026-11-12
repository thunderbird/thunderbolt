/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import CryptoKit
import Foundation
import ImageIO
import PDFKit
import UniformTypeIdentifiers

struct AttachmentReference: Codable, Equatable, Identifiable, Sendable {
    let localFileId: String
    let filename: String
    let mimeType: String
    var deliverAs: String?
    var id: String { localFileId }

    var part: ChatContentPart {
        var data: [String: ChatJSONValue] = [
            "localFileId": .string(localFileId), "filename": .string(filename), "mimeType": .string(mimeType),
        ]
        if let deliverAs { data["deliverAs"] = .string(deliverAs) }
        return ChatContentPart(rawValue: .object(["type": .string("data-attachment"), "data": .object(data)]), fallbackID: localFileId)
    }

    init(localFileId: String, filename: String, mimeType: String, deliverAs: String? = nil) {
        self.localFileId = localFileId
        self.filename = filename
        self.mimeType = mimeType
        self.deliverAs = deliverAs
    }

    init?(part: ChatContentPart) {
        guard part.isAttachment, let id = part.attachmentLocalID, let name = part.attachmentFilename,
              let mime = part.attachmentMIMEType else { return nil }
        self.init(localFileId: id, filename: name, mimeType: mime, deliverAs: part.data?["deliverAs"]?.stringValue)
    }
}

struct StoredAttachment: Codable, Sendable {
    let reference: AttachmentReference
    let bytes: Data
}

struct AttachmentDraftTarget: Sendable {
    let owner: String
    let lifetime: UUID
    let conversationID: String
}

enum AttachmentError: LocalizedError {
    case tooLarge, tooMany, unsupported, invalidReference, unreadable
    var errorDescription: String? {
        switch self {
        case .tooLarge: nativeString( "Each attachment must be 25 MB or smaller.")
        case .tooMany: nativeString( "You can attach up to 10 files to a message.")
        case .unsupported: nativeString( "Choose an image, PDF, Word document, spreadsheet, or text file.")
        case .invalidReference: nativeString( "This attachment reference is invalid.")
        case .unreadable: nativeString( "This file could not be opened.")
        }
    }
}

/// File bytes stay on this device. Only reference parts enter the encrypted sync
/// database; an account/server hash scopes local bytes and prevents cross-account reads.
actor AttachmentStore {
    static let maximumCount = 10
    static let maximumBytes = 25 * 1024 * 1024
    static let acceptedExtensions = Set(["pdf", "png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "docx", "xlsx", "md", "txt", "csv", "json"])
    private let directory: URL

    init(directory: URL = URL.applicationSupportDirectory.appending(path: "Attachments")) {
        self.directory = directory
    }

    func importFile(_ url: URL, owner: String) throws -> AttachmentReference {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let type = try url.resourceValues(forKeys: [.contentTypeKey]).contentType
        return try store(Data(contentsOf: url), filename: url.lastPathComponent,
            mimeType: type?.preferredMIMEType, owner: owner)
    }

    func store(_ bytes: Data, filename: String, mimeType: String?, owner: String) throws -> AttachmentReference {
        let ext = (filename as NSString).pathExtension.lowercased()
        guard Self.acceptedExtensions.contains(ext) || mimeType?.hasPrefix("image/") == true || mimeType?.hasPrefix("text/") == true else {
            throw AttachmentError.unsupported
        }
        let mime = ["md", "txt", "csv", "json"].contains(ext)
            ? (ext == "json" ? "application/json" : "text/plain")
            : mimeType ?? UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        let prepared = try Self.prepare(bytes, filename: filename, mimeType: mime)
        guard prepared.bytes.count <= Self.maximumBytes else { throw AttachmentError.tooLarge }
        let reference = AttachmentReference(localFileId: UUID().uuidString.lowercased(), filename: prepared.filename, mimeType: prepared.mimeType)
        let value = StoredAttachment(reference: reference, bytes: prepared.bytes)
        let location = try location(id: reference.id, owner: owner)
        try FileManager.default.createDirectory(at: location.deletingLastPathComponent(), withIntermediateDirectories: true)
        let encoder = PropertyListEncoder()
        encoder.outputFormat = .binary
        try encoder.encode(value).write(to: location, options: [.atomic, .completeFileProtection])
        return reference
    }

    func load(_ reference: AttachmentReference, owner: String) throws -> StoredAttachment? {
        let url = try location(id: reference.id, owner: owner)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let file = try PropertyListDecoder().decode(StoredAttachment.self, from: Data(contentsOf: url))
        guard file.reference.id == reference.id, file.bytes.count <= Self.maximumBytes else { throw AttachmentError.invalidReference }
        return file
    }

    func previewURL(_ reference: AttachmentReference, owner: String) throws -> URL? {
        guard let file = try load(reference, owner: owner) else { return nil }
        let folder = try location(id: reference.id, owner: owner).deletingPathExtension()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let name = (file.reference.filename as NSString).lastPathComponent
        guard name != ".", name != "..", !name.isEmpty else { throw AttachmentError.invalidReference }
        let url = folder.appending(path: name)
        try file.bytes.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    /// Account removal is the explicit hard-delete flow; ordinary chat deletion
    /// only writes synchronized tombstones.
    func removeAccount(owner: String) throws {
        let account = SHA256.hash(data: Data(owner.utf8)).map { String(format: "%02x", $0) }.joined()
        let folder = directory.appending(path: account)
        if FileManager.default.fileExists(atPath: folder.path) { try FileManager.default.removeItem(at: folder) }
    }

    func extractedText(_ file: StoredAttachment) throws -> String? {
        if file.reference.mimeType.hasPrefix("text/") || file.reference.mimeType == "application/json" {
            guard let text = String(data: file.bytes, encoding: .utf8) ?? String(data: file.bytes, encoding: .utf16) else {
                throw AttachmentError.unreadable
            }
            return text
        }
        if file.reference.mimeType == "application/pdf" {
            guard let document = PDFDocument(data: file.bytes) else { throw AttachmentError.unreadable }
            return document.string
        }
        return nil
    }

    private func location(id: String, owner: String) throws -> URL {
        guard UUID(uuidString: id) != nil, !owner.isEmpty else { throw AttachmentError.invalidReference }
        let account = SHA256.hash(data: Data(owner.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appending(path: account).appending(path: id.lowercased() + ".plist")
    }

    private static func prepare(_ bytes: Data, filename: String, mimeType: String) throws -> (bytes: Data, filename: String, mimeType: String) {
        let needsConversion = mimeType == "image/heic" || mimeType == "image/heif"
        guard mimeType.hasPrefix("image/"), mimeType != "image/gif",
              needsConversion || bytes.count > 10 * 1024 * 1024 else { return (bytes, filename, mimeType) }
        guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 2048,
              ] as CFDictionary) else { throw AttachmentError.unreadable }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw AttachmentError.unreadable
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw AttachmentError.unreadable }
        guard needsConversion || output.length < bytes.count else { return (bytes, filename, mimeType) }
        return (output as Data, (filename as NSString).deletingPathExtension + ".jpg", "image/jpeg")
    }
}
