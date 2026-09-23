# Chat Attachments

Users attach PDFs, images, Word documents, and plain-text files to a chat turn. One invariant shapes the subsystem:
**the bytes are never stored off-device. They leave only in-flight, inside the request that answers the turn.**

## Limits and accepted types

| Limit                        | Value | Where                                                                                                                       |
| ---------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| Files per message            | 10    | `maxAttachmentCount`, `chat-prompt-input.tsx`                                                                               |
| Bytes per file (post-shrink) | 25 MB | `maxAttachmentBytes`, `chat-prompt-input.tsx`                                                                               |
| Compression threshold        | 10 MB | `compressionThresholdBytes`, [`src/files/compress/compress-attachment.ts`](../../src/files/compress/compress-attachment.ts) |

Accepted types: PDF, PNG/JPEG/WebP/GIF, DOCX, and Markdown/plain text/CSV/JSON.

## Where the bytes live

Bytes go to IndexedDB (`thunderbolt-files`, [`src/lib/file-blob-storage.ts`](../../src/lib/file-blob-storage.ts))
keyed by a fresh UUID. The message carries only that key:

```ts
type AttachmentData = {
  localFileId: string
  filename: string
  mimeType: string
  deliverAs?: 'text' | 'images'
}
```

It rides the message as a `data-attachment` part ([`src/lib/attachments.ts`](../../src/lib/attachments.ts),
[`src/types.ts`](../../src/types.ts)). AI SDK `data-*` parts are UI-only (`convertToModelMessages` ignores them), so
a persisted message is inert until a transport hydrates it at send time.

One exception: the Deepset-backed ACP agent posts each embedded resource to Deepset's `temporary_files` endpoint for
the run's duration rather than indexing it into a workspace
([`backend/src/haystack/acp-server.ts`](../../backend/src/haystack/acp-server.ts)).

### Why `putAttachment` copies the bytes

A `File` from an `<input>` or a drop is a path reference, and IndexedDB persists it as one, so moving or editing the
source makes later reads throw `NotReadableError`. Stateless chat re-reads the whole history per send, so one
invalidated file poisons the conversation. Hence the one-time `detachBytes` copy.

### What follows from the invariant

- **Attachments do not follow a chat to another device.** The reference syncs (inside `chat_messages.parts`,
  encrypted when E2EE is on, [`src/db/encryption/config.ts`](../../src/db/encryption/config.ts)), the bytes do not.
  `getAttachment` returns `null` there: the AI SDK path sends the turn without it, the built-in and ACP transports
  substitute a note naming the file. The card renders the filename, not the thumbnail.
- **Attachments are absent from the data export.** The exporter walks Drizzle tables
  ([`src/dal/export.ts`](../../src/dal/export.ts)); the blob store is not one, so an export round-trips the
  reference and loses the file. See [export-format.md](./export-format.md).
- **A project knowledge base could never have held file bytes**, which is why the removed version stored extracted
  text. See [projects.md](./projects.md#knowledge-and-why-it-isnt-here).

## Entering the app

The composer ([`src/components/chat/chat-prompt-input.tsx`](../../src/components/chat/chat-prompt-input.tsx)) is the
only door: paperclip, drag-and-drop, and paste funnel into one `addFiles`. Paste is intercepted only when the
clipboard carries files; a pasted screenshot arrives unnamed and is given a synthetic, extension-bearing name.

Acceptance is by MIME type **or** extension, because a file picker reports `.md` with an empty `type`.
[`resolveTextMimeType`](../../src/files/transformers/index.ts) then normalizes it to `text/plain`: delivery mode is
chosen from the MIME type, and an empty type routes a file as native bytes the model cannot read.

### Compression runs before the cap, not after

| Input           | What happens                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PNG/JPEG/WebP   | Downscaled to a 2048px longest edge, re-encoded as WebP at quality 0.82 ([`compress-image.ts`](../../src/files/compress/compress-image.ts))                                           |
| GIF             | Excluded; canvas re-encoding would flatten an animation to one frame                                                                                                                  |
| PDF             | Lossless re-save through pdf-lib with object streams ([`compress-pdf.ts`](../../src/files/compress/compress-pdf.ts)); sheds unreferenced objects, does not recompress embedded images |
| Everything else | Passes through; generic byte compression is pointless when the model has to read the bytes                                                                                            |

`maybeCompressAttachment` runs before the size check, so a 30 MB phone photo can shrink under the 25 MB limit
instead of being rejected. Failures log and return the original, as do the image and PDF paths when the result is
not smaller.

The image path decodes with `imageOrientation: 'from-image'` because canvas encoding drops EXIF, so a portrait photo
would come out sideways with no metadata left to correct it.

## Delivery is native-first

| Transport                                                                                     | Current-turn attachment becomes                                                                 |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| AI SDK ([`src/lib/attachments.ts`](../../src/lib/attachments.ts))                             | A `file` part with the bytes as a data URL, one image part per page under `deliverAs: 'images'` |
| Built-in agent ([`src/acp/built-in-conversation.ts`](../../src/acp/built-in-conversation.ts)) | Text plus Pi `image` blocks; Pi has no document block, so PDF/DOCX always extract to text       |
| ACP ([`src/acp/acp-adapter.ts`](../../src/acp/acp-adapter.ts))                                | An embedded `resource` block (base64) when the agent advertises `embeddedContext`, else text    |

`defaultDeliveryMode` ([`src/files/transformers/index.ts`](../../src/files/transformers/index.ts)) returns `'text'`
for plain-text MIME types and `undefined` (native bytes) otherwise. An explicit `deliverAs` overrides it, and is how
remediation records its decision durably enough to survive `regenerate()` and a reload.

### Only the current turn is delivered in full

`hydrateAttachmentsAsFileParts` sends the latest user turn's attachments at full fidelity and reduces every
**earlier** turn to extracted text, or a bare `[Attachment: name]` line when nothing extracts.

Stateless chat replays the whole history per send. Re-inlining old bytes would bloat every request, and would
poison the thread if one historical attachment became undeliverable: the bad part replays forever and every later
send fails, including a plain-text follow-up. For the same reason a missing attachment is not an error, the reference part stays (dropped from model
input by `convertToModelMessages`) and the turn goes without it.

### Why ACP degrades instead of rasterizing

An ACP agent parses files itself, so native bytes are the right default. `embeddedContext` is not in the ACP
baseline (only `Text` and `ResourceLink` are guaranteed), so without it a text-extractable PDF or DOCX goes as an
extracted `text` block and anything else gets a visible "could not be delivered" note.

That is **not** the remediation ladder: ACP never rasterizes, because a harness wants real bytes rather than our
lossy page images. A `deliverAs` the ladder set is still honoured, both `'text'` and `'images'` send extracted text
on the embedded path.

## The transformer registry

[`src/files/transformers/index.ts`](../../src/files/transformers/index.ts) maps lazy loaders keyed
`"<source-mime>-><target>"`, where target is `'text'` or `'images'`:

| Key                       | Module                                                              | Dependency |
| ------------------------- | ------------------------------------------------------------------- | ---------- |
| `application/pdf->text`   | [`pdf-to-text.ts`](../../src/files/transformers/pdf-to-text.ts)     | pdfjs-dist |
| `application/pdf->images` | [`pdf-to-images.ts`](../../src/files/transformers/pdf-to-images.ts) | pdfjs-dist |
| `<docx mime>->text`       | [`docx-to-text.ts`](../../src/files/transformers/docx-to-text.ts)   | mammoth    |

Text-ish types (`text/*`, `application/json`) resolve to
[`text-passthrough.ts`](../../src/files/transformers/text-passthrough.ts) with no entry.
[`docx-to-html.ts`](../../src/files/transformers/docx-to-html.ts) is in the folder but not the registry: it serves
the preview pane, and lives here so the viewer and the delivery pipeline share one mammoth dependency.

Loaders are dynamic imports, keeping pdfjs and mammoth out of the entry bundle. `pdf-to-images` caps at
`maxPages = 10`, `renderScale = 2`: legible to a vision model, bounded so a long scan does not fire hundreds of
images at a provider.

### Adding a file type

One registry entry plus its module; `hasTransformer`, `getTransformer`, hydration, and the ladder all route off the
map. If the type is also new to the composer, add it to `acceptedAttachmentMimeTypes` and
`acceptedAttachmentExtensions`, and to `plainTextExtensions` if the OS reports an empty MIME type.

## The remediation ladder

A model rejecting a natively-sent file triggers convert-and-retry rather than an error.
[`use-attachment-remediation.ts`](../../src/components/chat/use-attachment-remediation.ts) walks three rungs,
**native → text → images**, bounded by the terminal `images` rung.

`nextRemediationTarget` is the pure core; `pickTarget` feeds it the per-file capabilities. Only the first hop
inspects the text layer: a PDF with at least `minUsefulTextLength` (16) trimmed characters is a digital document and
goes to text; one with none is a scan and jumps straight to images.

### Three details that keep it from misfiring

- **Only a genuine content rejection triggers it.** `isContentRejectionError`
  ([`src/lib/error-utils.ts`](../../src/lib/error-utils.ts)) requires a 400 or 422 and excludes rate limits, context
  overflow, and structured tool-parameter errors, none of which a conversion fixes. Status extraction covers the Pi
  path's flattened string errors (`getPiErrorStatusCode`), not just JSON bodies.
- **The starting rung is the mode currently in effect**, not the raw `deliverAs`. A plain-text file already going out
  as text would otherwise be re-sent text→text and then falsely declared unreadable.
- **Each delivery state is auto-attempted at most once**, keyed by message id plus every attachment's current mode. A
  rejection already present on first render is seeded into that set: it is a stale failure from a reopened thread,
  not a fresh send.

### What the UI does with it

`suppressError` is computed during render so the error frame before an imminent retry never paints.
`deliveryExhausted` makes the error UI show file-specific guidance ("this model couldn't read the attached file")
and drop the Retry button ([`error-message.tsx`](../../src/components/chat/error-message.tsx)).

After a conversion the sent bubble offers the remaining modes as manual "Resend as text/images" controls
([`message-bubbles.tsx`](../../src/components/chat/message-bubbles.tsx), wired only for the latest user turn by
[`chat-messages.tsx`](../../src/components/chat/chat-messages.tsx)). A clean native send shows no resend affordance.

## Viewing

| Card type            | Renders                                                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF, image, DOCX     | Blob read through `useLocalDocumentBlob` ([`src/widgets/document-result/use-document-blob.ts`](../../src/widgets/document-result/use-document-blob.ts)); the DOCX branch renders via `docxToHtml` |
| Markdown, other text | A snippet read straight from the store ([`text-snippet.tsx`](../../src/components/chat/text-snippet.tsx))                                                                                         |

The card ([`file-card.tsx`](../../src/components/chat/file-card.tsx)) renders a thumbnail per type, with react-pdf
lazily imported. Clicking a sent attachment opens it in the side view as a `local-file`
([`src/content-view/sideview.tsx`](../../src/content-view/sideview.tsx)). A non-native delivery mode shows as a badge
on the card.

## Known gaps

- **Blobs are never garbage-collected.** `deleteAttachment` is called from one place: removing a chip from the
  composer before sending. Sign-out, account deletion, and device revocation funnel through `clearLocalData`
  ([`src/lib/cleanup.ts`](../../src/lib/cleanup.ts)), which wipes the encryption-key store and the app directory but
  not `thunderbolt-files`, so a sent attachment's bytes outlive the chat, and the account.
- **Scanned PDFs have no OCR.** `pdf-to-text` reads only the embedded text layer; the images rung is the fallback,
  which needs a vision model on the other end.
- **Images have no remediation path.** An image has no text transformer and no image transformer, so a rejection
  reports exhausted immediately.

## Source map

| Concern                             | File                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| Blob store (IndexedDB)              | `src/lib/file-blob-storage.ts`                             |
| Message part + AI SDK hydration     | `src/lib/attachments.ts`, `src/types.ts`                   |
| Transformer registry                | `src/files/transformers/index.ts`                          |
| Compression                         | `src/files/compress/`                                      |
| Composer intake (picker/drop/paste) | `src/components/chat/chat-prompt-input.tsx`                |
| Remediation ladder                  | `src/components/chat/use-attachment-remediation.ts`        |
| Error classification                | `src/lib/error-utils.ts`                                   |
| Cards, thumbnails, resend controls  | `src/components/chat/file-card.tsx`, `message-bubbles.tsx` |
| Built-in agent delivery             | `src/acp/built-in-conversation.ts`                         |
| ACP delivery                        | `src/acp/acp-adapter.ts`                                   |
