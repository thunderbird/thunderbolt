/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

struct AttachmentPickerButton: View {
    let model: AppModel
    @State private var showsFiles = false
    @State private var showsPhotos = false
    @State private var selectedPhotos: [PhotosPickerItem] = []

    private var allowedTypes: [UTType] {
        [.image, .pdf, .plainText, .json, .commaSeparatedText] + ["md", "docx", "xlsx"].compactMap { UTType(filenameExtension: $0) }
    }

    var body: some View {
        Menu {
            Button("Photos", systemImage: "photo") { showsPhotos = true }
                .accessibilityIdentifier("choosePhotos")
            Button("Choose files", systemImage: "folder") { showsFiles = true }
                .accessibilityIdentifier("chooseFiles")
        } label: {
            Group {
                if model.isImportingAttachments { ProgressView() }
                else { Image(systemName: "paperclip").font(.system(size: 17)) }
            }
            .frame(width: 40, height: 40)
            .foregroundStyle(TBPalette.foreground)
        }
        .disabled(model.isImportingAttachments || model.draftAttachments.count >= AttachmentStore.maximumCount)
        .accessibilityLabel("Add attachment")
        .accessibilityIdentifier("addAttachment")
        .fileImporter(isPresented: $showsFiles, allowedContentTypes: allowedTypes, allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await model.importAttachments(urls) }
            case .failure(let error): model.attachmentError = error.localizedDescription
            }
        }
        .photosPicker(isPresented: $showsPhotos, selection: $selectedPhotos,
            maxSelectionCount: max(1, AttachmentStore.maximumCount - model.draftAttachments.count),
            matching: .images, preferredItemEncoding: .current)
        .onChange(of: selectedPhotos) { _, items in
            guard !items.isEmpty, let target = model.attachmentDraftTarget() else { return }
            Task {
                for (index, item) in items.enumerated() {
                    do {
                        guard let bytes = try await item.loadTransferable(type: Data.self) else { throw AttachmentError.unreadable }
                        let type = item.supportedContentTypes.first(where: { $0.conforms(to: .image) })
                        await model.importPhoto(bytes, filename: "Photo \(index + 1).\(type?.preferredFilenameExtension ?? "jpg")",
                            mimeType: type?.preferredMIMEType, target: target)
                    } catch { model.attachmentError = error.localizedDescription }
                }
                selectedPhotos = []
            }
        }
    }
}

struct AttachmentCard: View {
    let reference: AttachmentReference
    let model: AppModel
    var onRemove: (() -> Void)?
    @State private var preview: URL?
    @State private var unavailable = false

    var body: some View {
        HStack(spacing: 8) {
            Button {
                Task {
                    do {
                        preview = try await model.attachmentPreview(reference)
                        unavailable = preview == nil
                    } catch { model.attachmentError = error.localizedDescription }
                }
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: reference.mimeType.hasPrefix("image/") ? "photo" : "doc.text")
                        .foregroundStyle(TBPalette.brand)
                    Text(reference.filename).font(.subheadline).lineLimit(1)
                        .foregroundStyle(TBPalette.foreground)
                }
                .padding(.vertical, 12)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("attachment-\(reference.id)")
            if let onRemove {
                Button(action: onRemove) { Image(systemName: "xmark.circle.fill").foregroundStyle(TBPalette.muted) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(reference.filename)")
            }
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: 260)
        .background(TBPalette.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(TBPalette.border.opacity(0.5), lineWidth: 1))
        .quickLookPreview($preview)
        .alert("File unavailable", isPresented: $unavailable) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Attachment files stay on the device where you added them. Open this chat on that device to view the file.")
        }
    }
}
