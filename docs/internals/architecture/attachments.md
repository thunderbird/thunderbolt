# Chat Attachments

Users attach PDFs, images, Word documents, spreadsheets, and plain-text files to a chat turn. One invariant shapes the subsystem:
**the bytes are never stored off-device. They leave only in-flight, inside the request that answers the turn.**

## Limits and accepted types

| Limit                        | Value  | Where                                                                                                                          |
| ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Files per message            | 10     | `maxAttachmentCount`, `chat-prompt-input.tsx`                                                                                  |
| Bytes per file (post-shrink) | 25 MB  | `maxAttachmentBytes`, `chat-prompt-input.tsx`                                                                                  |
| Compression threshold        | 10 MB  | `compressionThresholdBytes`, [`src/files/compress/compress-attachment.ts`](../../../src/files/compress/compress-attachment.ts) |
| Unpacked size per XLSX       | 32 MiB | `maxUnpackedMib`, [`src/files/transformers/xlsx-to-text.ts`](../../../src/files/transformers/xlsx-to-text.ts)                  |

Accepted types: PDF, PNG/JPEG/WebP/GIF, DOCX, XLSX, and Markdown/plain text/CSV/JSON.

## Where the bytes live

Bytes go to IndexedDB (`thunderbolt-files`, [`src/lib/file-blob-storage.ts`](../../../src/lib/file-blob-storage.ts))
keyed by a fresh UUID. The message carries only that key:

```ts
type AttachmentData = {
  localFileId: string
  filename: string
  mimeType: string
  deliverAs?: 'text' | 'images'
}
```

It rides the message as a `data-attachment` part ([`src/lib/attachments.ts`](../../../src/lib/attachments.ts),
[`src/types.ts`](../../../src/types.ts)). AI SDK `data-*` parts are UI-only (`convertToModelMessages` ignores them), so
a persisted message is inert until a transport hydrates it at send time.

One exception: the Deepset-backed ACP agent posts each embedded resource to Deepset's `temporary_files` endpoint for
the run's duration rather than indexing it into a workspace
([`backend/src/haystack/acp-server.ts`](../../../backend/src/haystack/acp-server.ts)).

### Why `putAttachment` copies the bytes

A `File` from an `<input>` or a drop is a path reference, and IndexedDB persists it as one, so moving or editing the
source makes later reads throw `NotReadableError`. Stateless chat re-reads the whole history per send, so one
invalidated file poisons the conversation. Hence the one-time `detachBytes` copy.

### What follows from the invariant

- **Attachments do not follow a chat to another device.** The reference syncs (inside `chat_messages.parts`,
  end-to-end encrypted, [`src/db/encryption/config.ts`](../../../src/db/encryption/config.ts)), the bytes do not.
  `getAttachment` returns `null` there: the AI SDK path sends the turn without it, the built-in and ACP transports
  substitute a note naming the file. The card renders the filename, not the thumbnail.
- **Attachments are absent from the data export.** The exporter walks Drizzle tables
  ([`src/dal/export.ts`](../../../src/dal/export.ts)); the blob store is not one, so an export round-trips the
  reference and loses the file. See [export-format.md](export-format.md).
- **A project knowledge base could never have held file bytes**, which is why the removed version stored extracted
  text. See [projects.md](projects.md#knowledge-and-why-it-isnt-here).

## Entering the app

The composer ([`src/components/chat/chat-prompt-input.tsx`](../../../src/components/chat/chat-prompt-input.tsx)) is the
only door: paperclip, drag-and-drop, and paste funnel into one `addFiles`. Paste is intercepted only when the
clipboard carries files; a pasted screenshot arrives unnamed and is given a synthetic, extension-bearing name.

Acceptance is by MIME type **or** extension, because a file picker reports `.md` with an empty `type`.
[`resolveTextMimeType`](../../../src/files/transformers/index.ts) then normalizes it to `text/plain`: delivery mode is
chosen from the MIME type, and an empty type routes a file as native bytes the model cannot read.

### Compression runs before the cap, not after

| Input           | What happens                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PNG/JPEG/WebP   | Downscaled to a 2048px longest edge, re-encoded as WebP at quality 0.82 ([`compress-image.ts`](../../../src/files/compress/compress-image.ts))                                           |
| GIF             | Excluded; canvas re-encoding would flatten an animation to one frame                                                                                                                     |
| PDF             | Lossless re-save through pdf-lib with object streams ([`compress-pdf.ts`](../../../src/files/compress/compress-pdf.ts)); sheds unreferenced objects, does not recompress embedded images |
| Everything else | Passes through; generic byte compression is pointless when the model has to read the bytes                                                                                               |

`maybeCompressAttachment` runs before the size check, so a 30 MB phone photo can shrink under the 25 MB limit
instead of being rejected. Failures log and return the original, as do the image and PDF paths when the result is
not smaller.

The image path decodes with `imageOrientation: 'from-image'` because canvas encoding drops EXIF, so a portrait photo
would come out sideways with no metadata left to correct it.

## Delivery is native-first

| Transport                                                                                        | Current-turn attachment becomes                                                                   |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| AI SDK ([`src/lib/attachments.ts`](../../../src/lib/attachments.ts))                             | A `file` part with the bytes as a data URL, one image part per page under `deliverAs: 'images'`   |
| Built-in agent ([`src/acp/built-in-conversation.ts`](../../../src/acp/built-in-conversation.ts)) | Text plus Pi `image` blocks; PDF/DOCX extract to text, written to the workspace when tools are on |
| ACP ([`src/acp/acp-adapter.ts`](../../../src/acp/acp-adapter.ts))                                | An embedded `resource` block (base64) when the agent advertises `embeddedContext`, else text      |

`defaultDeliveryMode` ([`src/files/transformers/index.ts`](../../../src/files/transformers/index.ts)) returns `'text'`
for plain-text MIME types and for xlsx (no provider accepts a spreadsheet as a native file part, so native-first would only buy a guaranteed rejection and a retry), and `undefined` (native bytes) otherwise. An explicit `deliverAs` overrides it, and is how
remediation records its decision durably enough to survive `regenerate()` and a reload.

### Only the current turn is delivered in full

`hydrateAttachmentsAsFileParts` sends the latest user turn's attachments at full fidelity and reduces every
**earlier** turn to extracted text, or a bare `[Attachment: name]` line when nothing extracts.

Stateless chat replays the whole history per send. Re-inlining old bytes would bloat every request, and would
poison the thread if one historical attachment became undeliverable: the bad part replays forever and every later
send fails, including a plain-text follow-up. For the same reason a missing attachment is not an error, the reference part stays (dropped from model
input by `convertToModelMessages`) and the turn goes without it.

An attachment whose read or text extraction throws is not an error either. The AI SDK path, the built-in agent and
ACP all put `[Attachment "<name>" could not be read: <reason>]`
([`unreadableAttachmentNote`](../../../src/lib/attachments.ts)) in its place, so the model can tell the user why, and
send the rest of the message. The built-in agent re-prepares the whole history every turn, so there one throw would
otherwise break every later turn and manual compaction.

### The built-in agent queries text attachments from its workspace

When the turn's tools are on, every attachment the built-in agent receives as text is also written into the thread's
[harness workspace](in-browser-agent-harness.md#attachments-in-the-workspace) under
`attachments/<localFileId>/`, and the prompt carries its path plus a bounded preview: the whole content when short,
otherwise the first 200 lines (16,000 characters) and a marker saying how much was cut. One rule covers every size, so
short files read exactly as before, and a 10,000-row export no longer overflows the context window: the model
aggregates it with `bash`.

- **Tabular files land as TSV.** A CSV becomes `<name>.tsv` and each xlsx sheet `<sheet>.tsv` (sheet names that clean up
  to the same name get a ` (2)` suffix)
  ([`src/files/tabular.ts`](../../../src/files/tabular.ts)). The browser shell has no CSV parser, and `awk -F,`
  silently splits a quoted `"Hertz, LLC"` into two columns; tabs and line breaks inside a field become spaces so
  `awk -F'\t'` always sees the original columns. A CSV that doesn't convert cleanly (other delimiters, malformed
  quoting, ragged rows) keeps its original text. Other text (txt/md/json, extracted PDF/DOCX) is written as text.
- **History turns use the same shape**, so a harness rebuilt from history cannot overflow on an old attachment either.
- **IndexedDB stays the source of truth.** The full set is rewritten every send, so a model edit, a reload, the
  in-memory fallback, or a removed workspace all recover on the next send. A failed write is logged, not fatal.
- **Office edits read the original bytes.** The workspace holds only the extracted text, so `run_office_script` reads
  an attached `.docx`, `.xlsx` or `.pptx` from IndexedDB by its file name or id. It looks in the workspace only for a name
  that none of the thread's stored files has ([prompt and tools](prompt-and-tools.md)).
- **Tools off means inline.** With no `bash` to query with (`toolUsage === 0`), attachments are inlined whole, as on
  the AI SDK path.

### Why ACP degrades instead of rasterizing

An ACP agent parses files itself, so native bytes are the right default. `embeddedContext` is not in the ACP
baseline (only `Text` and `ResourceLink` are guaranteed), so without it a text-extractable PDF or DOCX goes as an
extracted `text` block and anything else gets a visible "could not be delivered" note.

That is **not** the remediation ladder: ACP never rasterizes, because a harness wants real bytes rather than our
lossy page images. A `deliverAs` the ladder set is still honoured, both `'text'` and `'images'` send extracted text
on the embedded path.

## The transformer registry

[`src/files/transformers/index.ts`](../../../src/files/transformers/index.ts) maps lazy loaders keyed
`"<source-mime>-><target>"`, where target is `'text'` or `'images'`:

| Key                       | Module                                                                 | Dependency              |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------- |
| `application/pdf->text`   | [`pdf-to-text.ts`](../../../src/files/transformers/pdf-to-text.ts)     | pdfjs-dist              |
| `application/pdf->images` | [`pdf-to-images.ts`](../../../src/files/transformers/pdf-to-images.ts) | pdfjs-dist              |
| `<docx mime>->text`       | [`docx-to-text.ts`](../../../src/files/transformers/docx-to-text.ts)   | mammoth                 |
| `<xlsx mime>->text`       | [`xlsx-to-text.ts`](../../../src/files/transformers/xlsx-to-text.ts)   | read-excel-file, fflate |

Text-ish types (`text/*`, `application/json`) resolve to
[`text-passthrough.ts`](../../../src/files/transformers/text-passthrough.ts) with no entry.
mammoth only extracts text. The DOCX preview is not a transformer: see [DOCX preview](#docx-preview).

Loaders are dynamic imports, keeping pdfjs, mammoth, read-excel-file and fflate out of the entry bundle.
`pdf-to-images` caps at `maxPages = 10`, `renderScale = 2`: legible to a vision model, bounded so a long scan does not
fire hundreds of images at a provider.

`xlsx-to-text` starts no Worker. read-excel-file starts `blob:` Workers to inflate large compressed sheets, and the
desktop and mobile app's CSP blocks them, so fflate first rewrites the workbook's zip with every entry stored
uncompressed. Before unpacking anything, `xlsx-to-text` reads the zip's directory and refuses a workbook over 32 MiB
unpacked, one with more parts than a rewritten zip can list (65,535), one with two files of the same name, or one with
a part named `__proto__`, which unpacking would turn into the prototype of its result. Each
refusal reaches the model as a could-not-be-read note. A deflated entry inflates to at most the size it declares, but a
stored entry is copied at its stored size, so each entry counts at the larger of the two and the total bounds memory
use. WebKit's memory peaks at about 16 times the unpacked size while reading, so the 32 MiB limit keeps it near
0.5 GiB.

### Adding a file type

One registry entry plus its module; `hasTransformer`, `getTransformer`, hydration, and the ladder all route off the
map. If the type is also new to the composer, add it to `acceptedAttachmentMimeTypes` and
`acceptedAttachmentExtensions`, and to `plainTextExtensions` if the OS reports an empty MIME type.

## The remediation ladder

A model rejecting a natively-sent file triggers convert-and-retry rather than an error.
[`use-attachment-remediation.ts`](../../../src/components/chat/use-attachment-remediation.ts) walks three rungs,
**native → text → images**, bounded by the terminal `images` rung.

`nextRemediationTarget` is the pure core; `pickTarget` feeds it the per-file capabilities. Only the first hop
inspects the text layer: a PDF with at least `minUsefulTextLength` (16) trimmed characters is a digital document and
goes to text; one with none is a scan and jumps straight to images.

### Three details that keep it from misfiring

- **Only a genuine content rejection triggers it.** `isContentRejectionError`
  ([`src/lib/error-utils.ts`](../../../src/lib/error-utils.ts)) requires a 400 or 422 and excludes rate limits, context
  overflow, structured tool-parameter errors, and a model rejecting the request's tools, none of which a conversion
  fixes. Status extraction covers the Pi
  path's flattened string errors (`getPiErrorStatusCode`), not just JSON bodies.
- **The starting rung is the mode currently in effect**, not the raw `deliverAs`. A plain-text file already going out
  as text would otherwise be re-sent text→text and then falsely declared unreadable.
- **Each delivery state is auto-attempted at most once**, keyed by message id plus every attachment's current mode. A
  rejection already present on first render is seeded into that set: it is a stale failure from a reopened thread,
  not a fresh send.

### What the UI does with it

`suppressError` is computed during render so the error frame before an imminent retry never paints.
`deliveryExhausted` makes the error UI show file-specific guidance ("this model couldn't read the attached file")
and drop the Retry button ([`error-message.tsx`](../../../src/components/chat/error-message.tsx)).

After a conversion the sent bubble offers the remaining modes as manual "Resend as text/images" controls
([`message-bubbles.tsx`](../../../src/components/chat/message-bubbles.tsx), wired only for the latest user turn by
[`chat-messages.tsx`](../../../src/components/chat/chat-messages.tsx)). A clean native send shows no resend affordance.

## Viewing

| Card type            | Renders                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF, image, DOCX     | Blob read through `useLocalDocumentBlob` ([`src/widgets/document-result/use-document-blob.ts`](../../../src/widgets/document-result/use-document-blob.ts)); the DOCX branch renders its pages as a [snapshot](#docx-preview) |
| Markdown, other text | A snippet read straight from the store ([`text-snippet.tsx`](../../../src/components/chat/text-snippet.tsx))                                                                                                                 |

The card ([`file-card.tsx`](../../../src/components/chat/file-card.tsx)) renders a thumbnail per type, with react-pdf
lazily imported. Clicking a sent attachment, or the chip of a file the agent created, opens it in the side view as a
`local-file` ([`src/content-view/sideview.tsx`](../../../src/content-view/sideview.tsx)). A non-native delivery mode
shows as a badge on the card.

### DOCX preview

[`docx-snapshot.ts`](../../../src/widgets/document-result/docx-snapshot.ts) renders a DOCX's pages with
`docx-preview`, loaded only when a DOCX opens. The same snapshot shows in the side panel, on the attachment card, and
for a document opened from a search result. The file is untrusted, so:

- The pages are built in a document with no window, so nothing in them loads or runs while they render. The
  library's altChunk support is off: an altChunk is HTML from the file, which it would show in a frame with no
  sandbox.
- The result is a static page in an `<iframe sandbox="">`. Its policy loads only its inline styles and `data:`
  pictures and fonts. Links lose their targets. So that the markup reads back as built, an inline picture's wrapper
  becomes a `<span>` (a `<div>` would close its paragraph), and legacy VML drawings drop the size the library
  measures for them, which is 0 with no layout.
- CSS that carries text from the file, such as a font name, has its `<` escaped, so it cannot close the style
  element.
- A file over 10 MiB, one whose `word/document.xml` unpacks to over 3.5 MB (about 1,000 pages), or one whose parts
  unpack to over 32 MiB in all gets a refusal, and Download still works. The app unpacks the parts itself, within
  those limits, and gives the library a copy stored without compression, because the library's zip reader unpacks a
  part in full before it checks the size the file declares. Part names resolve as that reader resolves them, so
  `word/x/../document.xml` counts as `word/document.xml`. A main part under another name is held to the 32 MiB total
  only.
- A file the library cannot read, damaged or using something it does not handle (a delimiter equation with no
  properties, for one), shows that it can't be previewed, and Download still works.
- Pages wider than the panel, as on a phone, scale down to its width
  ([`docx-pages.tsx`](../../../src/widgets/document-result/docx-pages.tsx)).

### Spreadsheet preview

An `.xlsx` or `.xlsm` opens as a read-only grid ([`src/components/xlsx-preview/`](../../../src/components/xlsx-preview)),
in its own lazy chunk. The grid starts a Worker ([`xlsx-preview.worker.ts`](../../../src/office/xlsx-preview.worker.ts))
that loads Excelize alone, without IronCalc or the script sandbox. The Worker keeps the workbook open for as long as
the preview is open. Closing the preview or opening another file terminates the Worker, and that is the only way to
free Excelize's memory.

Excelize reads values in their number formats, styles, sizes, merges, frozen panes and links, 50 rows at a time as
the grid shows them ([`xlsx-preview-reader.ts`](../../../src/office/xlsx-preview-reader.ts)). It parses the whole
sheet on its first call, about 1.6 s for 5,000 × 50 cells under Bun, and each cell after that costs microseconds.
Reading in chunks shows the first rows in half the time it takes to read the whole sheet with `GetRows` up front. A
row the file gives no height grows to fit its largest font, as Excel sizes it. Excelize saves no row heights.

Excelize cannot read charts, so the Worker also unzips the file with fflate, under the script tool's 64 MiB ceiling,
and parses the drawings with xmldom ([`xlsx-drawings.ts`](../../../src/office/xlsx-drawings.ts)). Bar, column, line, area,
pie and doughnut charts are drawn as SVG from the values the chart saved, or else from the range it reads, and bars
stack the way the file stacks them. Any other chart, including stacked lines and areas, is a placeholder that names
its type. Outside the grid, a list names every chart and picture for screen readers. The same pass finds what the
banner lists: hidden sheets, conditional formatting, formulas with no saved result, shapes and sparklines.

The limits live in [`xlsxPreviewLimits`](../../../src/office/constants.ts). A file over 2 MiB is refused before a
Worker starts, and Download still works. A sheet shows at most 5,000 rows, 50 columns, 50 charts and pictures,
20,000 chart values across its charts, 50 frozen rows and 10 frozen columns. A cell shows at most 1,000 characters.
The banner says what was cut.

A 2 MiB file can still unzip into millions of cells, and the scan and Excelize must agree on what they read. Two
bounds therefore hold whatever the file claims:

1. Before Excelize opens the file, every part it could parse (every part except pictures) must unzip to at most
   32 MiB in total. The largest ordinary workbook tested under the 2 MiB cap unzips to 11.7 MB.
2. Every worksheet, hidden ones included, is counted the way Excelize fills it in: each row out to its last cell,
   and the sheet out to its last row. A sheet past 500,000 cells (twice what the grid shows), with more than 10,000
   merged ranges, or with a drawing over 2 MiB is reported as too large. A chart may read only from a sheet that
   passed.

A workbook that Excelize could read differently from the scan is refused as damaged. That covers two zip entries
for one part (`\` counts as `/`), a relationship Id used twice, two sheets with the same name, and a sheet list
that differs from Excelize's.

Two runtime limits back these up. A call fails once Excelize's memory passes the script tool's ceiling, and a call
with no answer within a minute stops the Worker. Both report the workbook as too large, not damaged. The minute
starts only after the Worker has loaded Excelize. Loading has its own two minutes, and when they run out the
preview says it couldn't load and suggests checking the connection.

The preview reads relationships and the `<sheet>` tags of `workbook.xml` with a linear scan, and drawings and
charts with xmldom. It does not use the pattern scan in `formula-cache.ts`, which stays with the script
tool.

The grid renders in the app DOM. Cell text is React text. Styles are rebuilt from checked parts
([`cell-style.ts`](../../../src/components/xlsx-preview/cell-style.ts)). Links are styled text with no `href`. A
picture shows only from bytes inside the file, only for raster types, through a `blob:` URL the grid makes.

## Known gaps

- **Blobs are never garbage-collected.** `deleteAttachment` is called from one place: removing a chip from the
  composer before sending. Sign-out, account deletion, and device revocation funnel through `clearLocalData`
  ([`src/lib/cleanup.ts`](../../../src/lib/cleanup.ts)), which wipes the encryption-key store and the app directory but
  not `thunderbolt-files`, so a sent attachment's bytes outlive the chat, and the account.
- **Scanned PDFs have no OCR.** `pdf-to-text` reads only the embedded text layer; the images rung is the fallback,
  which needs a vision model on the other end.
- **Large text attachments still overflow without tools.** The AI SDK path and a tool-less built-in model inline the
  whole file, so a big CSV hits the context-window error there. Truncating instead would yield confidently wrong
  totals.
- **Workspace copies outlive deleted threads.** A thread's workspace, attachment copies included, is not removed when
  the thread is deleted. Deleting or editing the agent removes only the workspaces of threads it ran since the page
  loaded; the rest stay in OPFS until sign-out clears it.
- **Images have no remediation path.** An image has no text transformer and no image transformer, so a rejection
  reports exhausted immediately.

## Source map

| Concern                             | File                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| Blob store (IndexedDB)              | `src/lib/file-blob-storage.ts`                             |
| Message part + AI SDK hydration     | `src/lib/attachments.ts`, `src/types.ts`                   |
| Transformer registry                | `src/files/transformers/index.ts`                          |
| CSV parsing and TSV output          | `src/files/tabular.ts`                                     |
| Compression                         | `src/files/compress/`                                      |
| Composer intake (picker/drop/paste) | `src/components/chat/chat-prompt-input.tsx`                |
| Remediation ladder                  | `src/components/chat/use-attachment-remediation.ts`        |
| Error classification                | `src/lib/error-utils.ts`                                   |
| Cards, thumbnails, resend controls  | `src/components/chat/file-card.tsx`, `message-bubbles.tsx` |
| Built-in agent delivery             | `src/acp/built-in-conversation.ts`                         |
| ACP delivery                        | `src/acp/acp-adapter.ts`                                   |
