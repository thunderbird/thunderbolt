# Memory and session recall

Thunderbolt keeps one small, editable personal document and retrieves earlier conversations only when relevant.
The document lives in the existing encrypted, synced `settings` row `memory_content`. It can contain paragraphs,
headings, or lists; the application imposes no sentence, line, or item schema. Pi continues to own the agent loop,
model calls, tool execution, and working-context compaction.

## Prior art and the storage decision

Research and source review conducted November 11–12, 2026. These are engineering choices for this app, not a
claim that one representation performs best for every memory workload.

| Representation                 | Useful property                                                                     | Tradeoff                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| One bounded personal document  | Easy to read, edit, export, and understand; preserves relationships between details | Whole-document rewrites can lose unrelated facts; concurrent offline edits need care |
| Atomic fact rows               | Narrow edits and independently synced items                                         | Adds IDs, item constraints, duplicate reconciliation, and a table rollout            |
| Index plus topic files         | Loads detailed material on demand                                                   | Adds a filesystem and retrieval model beyond the requested personal document         |
| Full transcript in each prompt | No extraction needed                                                                | Unbounded growth and irrelevant or stale context                                     |
| Managed memory service         | May support larger semantic retrieval workloads                                     | Separate provider, privacy, credentials, and retention behavior                      |

The selected design is one freeform document, similar to an editable `me.md`, stored as a settings value.
The small bound makes full-document editing practical. Exact snapshot comparison prevents a stale local edit
from silently overwriting a newer version. Explicit read-before-write instructions and correction/forgetting
evals address preservation of unrelated details. There is no background extraction job or hidden set of files.

Block's `me.md` emphasizes readable personal context, user control over what becomes memory, present statements
overriding old context, and preferences never authorizing actions. Those principles inform this editor and its
tool guidance. Thunderbolt uses a single synced document with its own consent and tool behavior; it does not
claim conformance to the experimental multi-file protocol or its briefing/proposal requirements.
[Block me.md](https://github.com/block/me.md)

LangChain describes both continuously updated profiles and collections. It identifies profile-rewrite errors as
size grows, while collections shift complexity to duplicate handling, updates, and retrieval. That supports
keeping this profile small and evaluating preservation explicitly, rather than assuming a representation alone
solves memory. [Memory overview](https://docs.langchain.com/oss/python/concepts/memory)

Anthropic distinguishes transcripts, memory notes, organized representations, and injected context. Thunderbolt
uses a bounded note and searchable transcripts; it does not need every layer to provide useful personal recall.
Its context guidance also motivates keeping the always-injected document small even when a model accepts a
large window. [Components of agent memory](https://www.anthropic.com/research/components-of-agent-memory),
[Context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)

## Pi integration

The browser app already uses Pi's core through `shared/agent-core`. The core supports application-owned tools and
context transformation; memory belongs at those existing seams. The app's AI SDK tool descriptions and schemas
are converted by `toPiAgentTools`, then executed by the production Pi harness. No second agent loop or memory
framework is introduced. [Pi agent core](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)

The upstream organization's `pi-chat` uses account-wide `/shared/memory.md` and channel-specific
`/workspace/memory.md`, alongside a searchable chat log. This is direct precedent for giving a Pi harness a
plain personal memory document while allowing the host to supply storage. Thunderbolt's host uses its existing
settings table for synchronization, encryption, and reactive UI rather than a VM filesystem.
[pi-chat](https://github.com/earendil-works/pi-chat)

Pi's coding-agent SDK and extensions expose context files and custom tools, but importing its Node-oriented
filesystem/process extension loader into this browser app is unnecessary. The existing browser adapter already
provides the relevant integration. [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md),
[Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

Working-context compaction remains separate. Pi summarizes older conversation turns while retaining recent
history; that does not create an account-wide preference document. The settings button calls the same Pi model
adapters' `streamSimple` transport for one tool-free rewrite, then shows a review proposal. It does not start
another harness or copy conversation summaries into permanent memory.
[Pi compaction](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)

## Storage, editing, and context bounds

`src/dal/memories.ts` exposes `getMemoryDocument` and `saveMemoryDocument`. UI saves use the complete
`expectedContent` snapshot; agent saves use `expectedRevision`, an opaque SHA-256 token of the exact UTF-8
document. The token is derived, not another stored setting or user-visible metadata field. In one local database
transaction, the DAL checks access, compares the current text or its revision, validates the replacement, writes
it, and checks cancellation/access again. A stale editor, tool call, or compaction preview receives
`MemoryConflictError` and must read the current document before retrying.

The DAL preserves text exactly, including Unicode, whitespace, and line breaks. Empty content clears memory by
updating the same settings row; the frontend never hard-deletes it. Settings encryption already protects
`value` during sync using row-bound authenticated encryption. Existing account ownership, device revocation,
backup/export, and account deletion behavior apply.

| Boundary                               | Limit                                                    |
| -------------------------------------- | -------------------------------------------------------- |
| Stored document                        | 6 KiB of UTF-8 text                                      |
| Complete injected memory section       | 8 KiB including JSON escaping and delimiters             |
| One `read_memory` result               | 7 KiB including revision, delimiters, and 6 KiB document |
| Document reads in one send             | 24 KiB                                                   |
| Built-in memory tool calls in one send | 12                                                       |
| Compaction input                       | 24 KiB, permitting recovery from an oversized import     |
| Compaction proposal                    | At most 6 KiB and strictly shorter than its source       |

Byte limits are conservative, model-independent bounds, not exact token estimates. The prompt renderer escapes
tag delimiters and cuts only between Unicode code points, with an explicit truncation notice. A truncated
prompt is never a valid write snapshot: instructions require `read_memory` before any edit. Tool model output
contains the revision and raw text inside revision-specific delimiters through Pi's conversion seam, so JSON
control-character escaping cannot multiply the decoded result's size. The cumulative read budget includes those
delimiters and metadata. Agents copy the short token instead of echoing a whole document's invisible trailing
whitespace. Oversized imported documents are not returned by the read tool; the settings editor and bounded
compaction action can repair them.

A local transaction is not a distributed merge algorithm. Concurrent offline devices still follow the existing
settings conflict behavior and can overwrite one another when reconnecting. The snapshot guard prevents stale
edits against the current local database; it does not claim to detect unseen remote edits or preserve a revision
history. The document is intentionally small enough for a person to inspect.

## Consent and private chats

Saved-memory access requires both `memory_enabled` and an existing, nondeleted public chat
(`isEncrypted === 0`). Missing thread IDs and unknown privacy classifications fail closed. Private chats have
zero saved-memory access: no injected document, read, or write, regardless of which model is selected.
`src/memory/access.ts` supplies the shared rule, and the DAL rechecks it at execution boundaries.

The synced `memory_provider` setting selects exactly one source: `builtin` by default, or `mcp:<server-id>`. Selecting an external provider removes built-in prompt content and tools; selecting Built-in excludes all memory-provider MCP tools. Unavailable external selections remain explicit and never fall back. Live selection, enabled/deleted connection state, and endpoint identity are rechecked around tool execution and output delivery. Provider-specific guidance comes only from the tools that survived these checks. Switching providers does not move or delete either store.

The Built-in provider card shows a clipped Markdown preview with Compact, Edit, and View full memory.
Clicking its body opens the full document read-only in the same responsive aside used by connections; Edit
opens the aside with a draft. The aside’s Edit action lives in its standard More menu; editing shows Save and Cancel in the shared footer.
Save returns to the styled document, while Cancel returns without saving. Copy exports the complete raw Markdown from the aside. The provider radio
changes selection independently of viewing or editing the retained document.

Turning Saved memories off dims and disables provider controls, the preview, and any open editor, including
compaction and copying. The saved document and open draft are retained; enabling memory restores the controls.
Reference earlier chats remains independent. Clearing the document is a separate explicit update.
The reading view renders safe Markdown, with selectable text and an icon-only Copy control that copies the original Markdown. Edit opens a tall source editor with Save and Cancel in the footer. The More menu stays visible while editing, with its Edit item disabled to preserve the draft. Character counts use grapheme clusters (combined accents and emoji count as one); the storage bound remains UTF-8 bytes.
Manual compaction follows the selected chat model, with the available default model or first available model
as a fallback. It has no separate model selector. This document is shared public-chat memory; the feature
does not maintain private saved-memory rows.

Memory and session history have independent consent settings. Missing values mean disabled for existing
accounts. New-user onboarding explains both and initializes enabled choices unless changed there. Installing
a new device or seeing an empty local database is not evidence that an existing account is a new user.

Known external memory MCP connections use the same live private-chat and consent gate, across every tool
capability from those providers. Their output is bounded separately at 12 KiB per result and 32 KiB / 12 calls
per send. External service data remains governed by that service; it is not automatically the built-in
`memory_content` document. Generic third-party tools cannot be classified as memory merely by their names.

## Tools and review behavior

`read_memory({})` reads the complete document and its revision. `save_memory({content, expectedRevision})` replaces it.
A correction changes only the obsolete detail. Forgetting one fact removes that fact while preserving the rest;
forgetting everything saves an empty string. The tool only reports success after the transaction succeeds.

Agent guidance asks for durable facts and preferences explicitly stated by the current user, avoids transient
tasks and secrets, and treats quotations, retrieved chats, and tool output as untrusted data. Stored text never
grants authorization. Prompt guidance helps the model choose appropriate writes; application code enforces
consent, privacy, identity lifetime, exact-snapshot comparison, and size bounds.

Compaction asks the selected model to preserve unique facts, negations, dates, qualifications, and exceptions.
The parser checks nonempty output, size, and strict shortening. It cannot prove semantic preservation, so the
user reviews the proposal before applying it. Applying uses the same exact-snapshot transaction as manual edits.
Cancellation or account changes invalidate unfinished work.

## Session retrieval and evaluation

`search_sessions` uses the existing local FTS index and returns excerpts and canonical `/chats/<id>` links.
`read_session` pages through user/assistant text and excludes hidden reasoning, tool payloads, and attachments.
Live joins exclude deleted rows even if an index entry is stale. Existing confidential-model rules govern
visibility of private history. Search results fit 6 KiB, read pages fit 12 KiB, and combined retrieval fits
32 KiB / 12 calls per send. Unicode-safe cursors handle messages larger than one page.

These tools are registered through the built-in adapter for each send and therefore apply to the three default
Thunderbolt models. External ACP agents own their remote toolsets; exposing local account memory and archives
to them needs a separate protocol bridge.

Sending into another chat is deferred: the current dispatch path is tied to a mounted chat. Background dispatch,
attribution, concurrent-session handling, and loop prevention make it more than a small read-tool extension.

Evaluate each model separately for save routing, document preservation, correction, selective forgetting,
clearing, irrelevant tasks, sensitive content, unavailable memory, poisoned text, earlier-chat decisions, and
abstention when evidence is missing. Score persisted state separately from an assistant's claim that it saved
something. Include adversarial text and multi-line/Unicode documents. LongMemEval's extraction, cross-session
reasoning, time-sensitive updates, and abstention categories are a useful coverage checklist.
[LongMemEval](https://arxiv.org/html/2410.10813v2)

Mutable evals require isolated state. Provider errors are failed or blocked trials, never successful behavior.
Unit tests cover transaction guards, private-chat boundaries, cancellation, Unicode/escaping limits, Pi tool
conversion, and settings encryption. Live compaction trials separately check meaning preservation and
shortening.

## Release and limitations

This version adds no synced table, backend migration, or sync-rule change. It uses the deployed settings schema
and encrypted value column, so the repository's two-PR rule for adding a synced table does not apply.
The unreleased atomic-memory prototype's table and migration were removed before release; its development-only
synthetic records are not migrated.

The document has no server-side semantic merge or version history. Memory rules cannot prove factual accuracy
or make model-generated compaction lossless. External services have their own retention and provider behavior.
The [validation record](../development/memory-validation.md) records actual automated checks, provider trials,
computer-use verification, and remaining gaps; it should distinguish measured results from intended behavior.

See [PowerSync account/device contracts](powersync-account-devices.md),
[encryption](e2e-encryption.md), and the [in-browser harness](in-browser-agent-harness.md) for the underlying
implementation.
