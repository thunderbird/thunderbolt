# Chat Attachments

A user can attach files to a chat turn — PDFs, images, Word documents, and plain-text formats. One invariant
shapes the whole subsystem: **the bytes are never stored off-device — they leave only in-flight, inside the request
that answers the turn.** Everything else here (the reference-only message part, the transformer registry, the
delivery ladder) is a consequence of that decision.

## The device-local blob invariant

An attachment's bytes are written to IndexedDB under the `thunderbolt-files` database
([`src/lib/file-blob-storage.ts`](../../src/lib/file-blob-storage.ts)) and keyed by a freshly generated UUID. What
goes into the message is only that key:

```ts
type AttachmentData = {
  localFileId: string
  filename: string
  mimeType: string
  deliverAs?: 'text' | 'images'
}
```

It rides the message as a `data-attachment` part ([`src/lib/attachments.ts`](../../src/lib/attachments.ts),
[`src/types.ts`](../../src/types.ts)). AI SDK `data-*` parts are UI-only — `convertToModelMessages` ignores them — so
a persisted message is inert until a transport hydrates it. At send time the transport reads the blob back out of
IndexedDB and inlines it into the outgoing request; nothing is uploaded ahead of time. The one place bytes touch
storage beyond the device is the Deepset-backed ACP agent, whose backend posts each embedded resource to Deepset's
`temporary_files` endpoint for the duration of the run rather than indexing it into a workspace
([`backend/src/haystack/acp-server.ts`](../../backend/src/haystack/acp-server.ts)).

`putAttachment` copies the bytes rather than storing the `File` it was handed. A `File` from an `<input>` or a drop
is a reference to a path, and IndexedDB persists it as one, so editing or moving the source afterwards makes every
later read throw `NotReadableError`. Because a stateless chat re-reads the whole history on each send, a single
invalidated file would poison the entire conversation, not just its own turn — hence the one-time `detachBytes`
copy.

### What follows from it

- **Attachments do not follow a chat to another device.** The reference syncs (inside `chat_messages.parts`, which
  is an encrypted column when E2EE is on — see [`src/db/encryption/config.ts`](../../src/db/encryption/config.ts)),
  the bytes do not. On a second device `getAttachment` returns `null`: the AI SDK path leaves the reference part
  as-is and sends the turn without it, while the built-in and ACP transports substitute a short note naming the file
  that couldn't be delivered. The card still renders the filename; the thumbnail does not.
- **Attachments are absent from the data export.** The exporter walks Drizzle tables
  ([`src/dal/export.ts`](../../src/dal/export.ts)); the blob store is not one of them. An export therefore round-trips
  the reference and loses the file. See [export-format.md](./export-format.md).
- **It is why a project knowledge base could never have held file bytes.** The removed version stored extracted
  text for exactly this reason — a binary knowledge set would have worked only on the device that uploaded it. See
  [projects.md](./projects.md#knowledge-and-why-it-isnt-here) for what else went with it.

## Entering the app

The composer ([`src/components/chat/chat-prompt-input.tsx`](../../src/components/chat/chat-prompt-input.tsx)) is the
only door: the paperclip, drag-and-drop, and clipboard paste all funnel into one `addFiles`. Paste is intercepted
only when the clipboard actually carries files, so ordinary text paste is untouched; a pasted screenshot usually
arrives with an empty name and is given a synthetic, extension-bearing one so the accept check and the chip have
something to work with.

Acceptance is by MIME type **or** file extension, because a file picker reports `.md` with an empty `type`. The same
duality appears in [`resolveTextMimeType`](../../src/files/transformers/index.ts), which normalizes an unknown-but-
plain-text file to `text/plain` at the point it enters the app. That normalization is load-bearing rather than
cosmetic: delivery mode is chosen from the MIME type, and an empty type routes a file as native bytes the model
cannot read.

| Limit                        | Value | Where                                                                                                                       |
| ---------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| Files per message            | 10    | `maxAttachmentCount`, `chat-prompt-input.tsx`                                                                               |
| Bytes per file (post-shrink) | 25 MB | `maxAttachmentBytes`, `chat-prompt-input.tsx`                                                                               |
| Compression threshold        | 10 MB | `compressionThresholdBytes`, [`src/files/compress/compress-attachment.ts`](../../src/files/compress/compress-attachment.ts) |

Accepted types are PDF, PNG/JPEG/WebP/GIF, DOCX, and Markdown/plain text/CSV/JSON.

### Compression runs before the cap, not after

`maybeCompressAttachment` is called before the size check, so a 30 MB phone photo can shrink under the 25 MB limit
instead of being rejected outright. It is best-effort throughout — any failure logs and returns the original file.

Raster images (PNG/JPEG/WebP) are downscaled to a 2048px longest edge and re-encoded as WebP at quality 0.82
([`compress-image.ts`](../../src/files/compress/compress-image.ts)); the bitmap is decoded with
`imageOrientation: 'from-image'` because canvas encoding drops EXIF entirely, and a portrait phone photo would
otherwise come out sideways with no metadata left to correct it. GIF is deliberately excluded — canvas re-encoding
would flatten an animation to one frame. PDFs get a lossless re-save through pdf-lib with object streams
([`compress-pdf.ts`](../../src/files/compress/compress-pdf.ts)), which sheds unreferenced objects but does not
recompress embedded images. Both return `null` when the result is not smaller, and the caller keeps the original.
Everything else passes through: generic byte compression is pointless when the model has to read the bytes.

## Delivery is native-first

The default is to hand the model the real file and let it do its own parsing. `defaultDeliveryMode`
([`src/files/transformers/index.ts`](../../src/files/transformers/index.ts)) returns `'text'` for plain-text MIME
types — lossless and universally accepted — and `undefined` (native bytes) for everything else. An explicit
`deliverAs` on the reference overrides it, and is how remediation records its decision durably enough to survive
`regenerate()` and a reload.

### Only the current turn is delivered in full

`hydrateAttachmentsAsFileParts` delivers the latest user turn's attachments at full fidelity and reduces every
**earlier** turn's attachments to extracted text, or a bare `[Attachment: name]` line when nothing can be extracted.
Historical attachments are never re-sent as native bytes. Stateless chat replays the whole history on every send, so
re-inlining old bytes both bloats each request and — the reason this rule exists — poisons the entire thread if any
one historical attachment is undeliverable: the bad part replays forever and every subsequent send fails, including
a plain-text follow-up.

For the same reason, a missing or unreadable attachment is not an error. The reference part is left in place (and
dropped from model input by `convertToModelMessages`) and the turn goes out without it.

### Three transports, three shapes

| Transport                                                                                     | Current-turn attachment becomes                                                                 |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| AI SDK ([`src/lib/attachments.ts`](../../src/lib/attachments.ts))                             | A `file` part with the bytes as a data URL, one image part per page under `deliverAs: 'images'` |
| Built-in agent ([`src/acp/built-in-conversation.ts`](../../src/acp/built-in-conversation.ts)) | Text plus Pi `image` blocks — Pi has no document block, so PDF/DOCX always extract to text      |
| ACP ([`src/acp/acp-adapter.ts`](../../src/acp/acp-adapter.ts))                                | An embedded `resource` block (base64) when the agent advertises `embeddedContext`, else text    |

The ACP path is the one worth reading the rationale for. An ACP agent is itself a harness that reads and parses
files, so native bytes are the right default; but `embeddedContext` is not part of the ACP baseline (only `Text`
and `ResourceLink` are guaranteed). Without it the adapter degrades rather than silently dropping the file — a
text-extractable PDF or DOCX goes as an extracted `text` block and anything else gets a visible
"could not be delivered" note in the prompt. That degradation is **not** the remediation ladder: ACP never
rasterizes, because a harness wants the real bytes rather than our lossy page images. A `deliverAs` the ladder did
set is still honoured on the embedded path — both `'text'` and `'images'` send extracted text instead of bytes.

## The transformer registry

Transformers turn a stored blob into something a transport can carry.
[`src/files/transformers/index.ts`](../../src/files/transformers/index.ts) is a map of lazy loaders keyed
`"<source-mime>-><target>"`, where target is `'text'` or `'images'`:

| Key                       | Module                                                              | Dependency |
| ------------------------- | ------------------------------------------------------------------- | ---------- |
| `application/pdf->text`   | [`pdf-to-text.ts`](../../src/files/transformers/pdf-to-text.ts)     | pdfjs-dist |
| `application/pdf->images` | [`pdf-to-images.ts`](../../src/files/transformers/pdf-to-images.ts) | pdfjs-dist |
| `<docx mime>->text`       | [`docx-to-text.ts`](../../src/files/transformers/docx-to-text.ts)   | mammoth    |

Every text-ish type (`text/*` and `application/json`) resolves to
[`text-passthrough.ts`](../../src/files/transformers/text-passthrough.ts) without an explicit entry, so any text
format works without enumerating it. [`docx-to-html.ts`](../../src/files/transformers/docx-to-html.ts) sits in the
same folder but is not in the registry — it serves the preview pane, and lives here so the viewer and the delivery
pipeline share one mammoth dependency.

Each loader is a dynamic import so pdfjs and mammoth stay out of the entry bundle and load only when a file of that
type actually needs converting. **Adding a file type is a one-line entry plus its module** — `hasTransformer`,
`getTransformer`, hydration, and the remediation ladder all route off the map, and nothing in the pipeline learns
the concrete type. If the type is also new to the composer, add it to `acceptedAttachmentMimeTypes` and
`acceptedAttachmentExtensions`, and to `plainTextExtensions` if the OS reports it with an empty MIME type.

`pdf-to-images` caps at `maxPages = 10` at `renderScale = 2` — enough for small text to stay legible to a vision
model, bounded so a long scan does not fire hundreds of images at a provider.

## The remediation ladder

When a model rejects a file it was sent natively, the app converts and retries rather than surfacing an error.
[`use-attachment-remediation.ts`](../../src/components/chat/use-attachment-remediation.ts) walks a three-rung
ladder — **native → text → images** — bounded by the terminal `images` rung, so the chain is finite.

`nextRemediationTarget` is the pure core and is worth reading on its own; `pickTarget` feeds it the per-file
capabilities. Only the first hop inspects the text layer: if a PDF yields at least `minUsefulTextLength` (16)
trimmed characters it is a digital document and goes to text; if it yields nothing it is a scan, and text would be
a wasted round trip, so the ladder jumps straight to images.

Three details keep it from misfiring:

- **Only a genuine content rejection triggers it.** `isContentRejectionError`
  ([`src/lib/error-utils.ts`](../../src/lib/error-utils.ts)) requires a 400 or 422 and excludes rate limits, context
  overflow, and structured tool-parameter errors. Converting a file cannot fix those, and churning the ladder would
  end in a misleading "couldn't read the file". Status extraction also covers the Pi path's flattened string error
  formats (`getPiErrorStatusCode`), not just JSON bodies.
- **The starting rung is the mode currently in effect**, not the raw `deliverAs`. A plain-text file already going out
  as text must not be treated as an untried "native" rung, or it would be re-sent text→text and then falsely
  declared unreadable.
- **Each delivery state is auto-attempted at most once**, tracked by a signature of the message id plus every
  attachment's current mode. A content rejection already present on first render is seeded into that set: it is a
  stale failure from a reopened thread, not a fresh send, and re-running it would surprise the user.

The hook returns `suppressError` — computed synchronously during render, so the error frame before an imminent
automatic retry never paints — and `deliveryExhausted`, which makes the error UI show file-specific guidance ("this
model couldn't read the attached file") and drop the Retry button, since identical input would fail identically
([`error-message.tsx`](../../src/components/chat/error-message.tsx)). When the ladder has already converted a file,
the sent bubble offers the remaining modes as manual "Resend as text/images" controls
([`message-bubbles.tsx`](../../src/components/chat/message-bubbles.tsx), wired only for the latest user turn by
[`chat-messages.tsx`](../../src/components/chat/chat-messages.tsx)); a clean native send shows no resend affordance
at all.

## Viewing

An attachment card ([`file-card.tsx`](../../src/components/chat/file-card.tsx)) renders a thumbnail per type. PDF,
image, and DOCX cards read the blob through
`useLocalDocumentBlob` ([`src/widgets/document-result/use-document-blob.ts`](../../src/widgets/document-result/use-document-blob.ts)) —
the DOCX branch renders via `docxToHtml` — while Markdown and other text files render a snippet read straight from
the store ([`text-snippet.tsx`](../../src/components/chat/text-snippet.tsx)). Clicking a sent attachment opens it in
the side view as a `local-file`
([`src/content-view/sideview.tsx`](../../src/content-view/sideview.tsx)). react-pdf is lazily imported so the entry
bundle does not carry it. A non-native delivery mode is shown as a small badge on the card, so "this went as text"
is visible rather than inferred.

## Known gaps

- **Blobs are never garbage-collected.** `deleteAttachment` is called from exactly one place: removing a chip from
  the composer before sending. Sign-out, account deletion, and device revocation all funnel through
  `clearLocalData` ([`src/lib/cleanup.ts`](../../src/lib/cleanup.ts)), which wipes the encryption-key store and the
  app directory but not `thunderbolt-files` — so a sent attachment's bytes outlive the chat, and the account.
- **Scanned PDFs have no OCR.** `pdf-to-text` reads only the embedded text layer; the images rung is the fallback,
  which needs a vision model on the other end.
- **Images have no remediation path.** If a model rejects an image there is no rung to advance to — it has no text
  transformer and no image transformer — so the ladder reports exhausted immediately.

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
