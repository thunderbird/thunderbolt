# Memory and session-history validation

## Current policy follow-up: November 12

Chat-level privacy has been removed. Existing chats, including legacy `isEncrypted: 1` or null rows, use memory and retrieval under the same consent settings. Model and agent switching, voice, and automation no longer impose chat privacy restrictions. Connection confidentiality, attestation, and synced-data encryption remain independent protections. Historical private-chat exclusion results below describe the earlier policy and are superseded by this follow-up.

Compact now lives in the built-in memory aside, retaining review and stale-proposal checks. Desktop asides use an opaque theme surface instead of the sidebar token that macOS vibrancy makes translucent.

The scoped suite passed **11,080 tests** (10,229 frontend, 838 shared/scripts, 13 e2e helpers). Eleven Chromium scenarios passed across the main run and a focused rerun: four Memory, four model-aside, and three connection-attestation cases. The initial provider-selection attempt was interrupted by source hot reload and passed after edits stopped. TypeScript, production build, scoped lint (existing warnings only), localization extraction, and license checks passed. Native computer use verified the opaque Add Model panel and Compact in the memory aside. Paid model trials were not repeated; the former private-chat eval now expects successful recall and persistence on a legacy chat row.

Validated in `codex/memory-and-session-tools`, based on main revision `ff0123d2514d488285b7bc5e79ee162b6761e487`. The user subsequently changed the design from memory rows to one freeform document. Results for the discarded row implementation are retained as historical artifacts and are **not** acceptance results for the current document contract.

## Current implementation

Memory is the existing encrypted, synced `memory_content` settings value, with a 6 KiB UTF-8 document limit and an 8 KiB injected-context limit. There is no new memories table or backend migration. Private chats cannot read or write this document or use recognized external memory-provider tools, regardless of which model they select.

Agents use `read_memory` to obtain the exact document and an opaque revision, then `save_memory` with the revised document and `expectedRevision`. The editor retains exact-content compare-and-swap internally. The revision avoids echoing the old document back into the tool call and avoids conflicts caused by a model dropping a trailing newline. Corrections preserve unrelated facts and remove obsolete values; forgetting one detail rewrites the remaining document, and an empty document clears memory.

## Live model evals

The dedicated runner uses the production built-in adapter, Pi harness, actual memory/session tools, SQLite mutations, and production FTS schema. Every attempt has an isolated database and a persisted public/private chat row before harness setup. The multi-turn scenario keeps one harness through save, correction, and recall. Assertions check actual tool calls, response facts, UTF-8 output budgets, and the final complete memory document.

| Model               | Actual model ID             | Transport                                                   |
| ------------------- | --------------------------- | ----------------------------------------------------------- |
| DeepSeek V4.1 Flash | `deepseek-v4-1-flash`       | Production confidential Tinfoil transport                   |
| GLM 5.3             | `glm-5-3`                   | Production confidential Tinfoil transport                   |
| Opus 5.5            | `anthropic/claude-opus-5.5` | Existing authorized OpenRouter connection in the native app |

The final opaque-revision memory matrix passed **78/78 trajectories**: thirteen cases, three samples per case, for Flash and GLM. The latest six session scenarios also passed three samples each for both models: **36/36 retrieval trajectories**. Together these cover all nineteen scenarios with **114/114 passes**. Session trials precede the memory-only revision-token change and retain their original fingerprints; the combined summary identifies both source journals. Retrieval cases cover targeted search/read, a self-contained request, history disabled, retrieved instructions, deleted chats with stale FTS entries, and large multilingual outputs.

The thirteen memory cases cover multi-turn reuse, explicit save, automatic saving of an explicitly stated durable preference, transient instructions, quoted fictional dialogue, a synthetic credential, correction with unrelated facts preserved, forgetting one fact, clearing all memory, private-chat isolation, recall, disabled memory, and injected instructions.

Positive tool-compatibility cases explicitly create public fixture chats for each model. In the current app, a new chat inherits its privacy classification from the selected model: the confidential Flash/GLM defaults create private chats, so those chats deliberately receive no saved-memory access. The private-chat scenarios test that exclusion; the positive fixture results do not imply that the app overrides it.

Freeform compaction passed **6/6 live trials** across Flash and GLM. The actual Settings function ran through `resolvePiModel` and Pi's `models.streamSimple`; all six proposals were manually reviewed. A 314-byte document shrank to 206–222 bytes while preserving Celsius/Fahrenheit qualification, a maintainer-versus-owner distinction, and a Friday-call exception for production outages. Native Opus also passed the actual Compact → review → Apply flow, shortening 133 to 126 bytes while preserving its exception.

### Findings and resulting changes

The first document matrix exposed one real correction failure: GLM retained a superseded Python preference as history. The shared correction instruction now explicitly removes old values, including “previously” and “changed from” wording, with an unrelated coffee/tea example. Subsequent correction cases passed for both models.

A multi-turn Flash trajectory then needed three read/write pairs because it dropped a trailing newline from `expectedContent` twice. The correct document was eventually saved, but the efficiency rubric failed. This drove the opaque-revision tool contract above rather than relaxing the retry limit.

Several fixture corrections were also made. The private-memory case disables the independently controlled session-history feature to isolate memory access. A relevant read of the memory document is allowed during recall and as a bounded fallback when session history is disabled. Retrieval uses a nonsecret launch codename instead of a “passphrase”, avoiding an unintended credential-handling test. Compaction preservation checks accept the valid wording “Phone calls: none on Fridays”. Original reports remain available.

Native testing of the earlier row design also caught a real driver mismatch: raw `db.all()` returned tuples through the Bun SQLite proxy but objects through PowerSync. Session search now uses typed Drizzle selections. Regression tests use the actual PowerSync Drizzle driver and lock-context API over SQLite, covering search/read and private-session exclusion. The later native Opus check retrieved the correct decision/date from another chat and its canonical source link opened that exact conversation.

## Provider integration checks

Supermemory, Mem0, Hindsight Cloud, and Zep use the existing generic MCP connection/OAuth path and shared records. Tests cover trusted origin classification, encoded/alternate paths, lookalike origins, explicit Hindsight bank scoping, picker filtering, setup delegation, shared-record management, and disabling Memory-page controls while memory consent is off. The main Connections page remains available for independent account setup. Connection creation reads current database records before matching the endpoint, so a connection synced after the picker loaded is reused even before its reactive list refreshes. The runtime gates all tools from recognized memory-service origins. The current MCP client has no separate resource/prompt API; no such nonexistent path is claimed as tested.

Public OAuth discovery was verified without signing in, registering a client, or writing memories. A follow-up on November 12 reached all four providers' resource and authorization metadata, including Zep after an earlier HTTP 403. All four advertised dynamic registration and PKCE S256. No successful external-memory grant is claimed; the user has no provider accounts and deferred those sign-ins. See [the provider research and architecture notes](../architecture/memory-providers.md).

## Automated and browser checks

| Check                                               | Result                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Scoped frontend/shared suites                       | 10,997 passed, 0 failed: 10,146 frontend, 838 shared/scripts, 13 scoped e2e unit tests |
| Agent-core suite                                    | 293 passed                                                                             |
| Production browser harness                          | 4 passed across Chromium and WebKit                                                    |
| Frontend TypeScript and production build            | Passed                                                                                 |
| Whole-project ESLint                                | 0 errors; 290 existing warnings                                                        |
| License headers                                     | Passed across 2,845 files                                                              |
| E2E collection                                      | All 93 specs collected                                                                 |
| Current Memory browser E2E                          | 4 passed: both scenarios repeated twice against the real consumer backend              |
| Dedicated eval framework                            | 247 passed, 0 failed; 1,648 assertions                                                 |
| Provider connection race regression and affected UI | 57 passed, 0 failed; 267 assertions                                                    |
| Final editor, compaction, and connection checks     | 71 passed after the final UI changes; 320 assertions                                   |
| Localization extraction                             | Stable across 14 catalogs on repeat extraction                                         |

The browser tests exercised freeform editing, copying, clearing, reloading, independently controlled toggles, all four provider choices in the filtered picker, and Hindsight bank validation. Computer use also verified editing and saving at a 390×844 viewport. Native testing verified the freeform editor and compaction preview/application. Opus exercised the final revision-token tool contract with one `read_memory` (30 ms) and one `save_memory` (17 ms). It saved a 128-byte document containing the current bullet-point preference, preserved the heading and Celsius exception, and removed the obsolete numbered-list preference. With both recall toggles off in a fresh chat, Opus made no memory/history calls, disclosed that it could not read or save memories, and neither leaked the saved facts nor claimed a save. Opus coverage is targeted native acceptance, not the full automated scenario matrix for the revised document contract.

The final desktop compaction reduced a deliberately wordy 349-byte QA document to 139 bytes, preserving both preferences and the Fahrenheit exception. Applying the reviewed proposal returned to the read-only editor. The isolated desktop app was left open on Settings → Memory with that clearly labeled QA document and both consent toggles restored to on. A proposal that cannot shorten the document now reports that specific outcome, while an in-progress request shows a busy indicator.

The design follow-up uses the existing settings shell and card treatment, single-line desktop toggle descriptions, and a 384-pixel minimum editor height on desktop and mobile. Compact now follows the selected chat model without a separate dropdown; the native Opus proposal flow was verified again. Official provider logos appear in the picker, setup, connected rows, and details. The current browser run passed both scenarios, including editor sizing, mobile overflow, one-line desktop copy, and four distinct locally loaded logos. Focused editor/connection tests passed 74 checks, the logo connection suites passed 84 checks, and TypeScript, scoped ESLint, production build, formatting, and license checks passed. The overlapping suite counts are not additive.

The single-provider follow-up selects Built-in or exactly one MCP connection through gradient radio controls. A request pins its selected provider and rechecks live consent and selection, so changing providers can remove access but cannot mix stores mid-request. Missing, disabled, deleted, and replaced connections fail closed. The read view renders safe Markdown, Copy is an icon at the document's lower corner, Edit becomes Save in the same toolbar, and the count reports visible characters while retaining the UTF-8 storage limit. Provider changes preserve both the saved document and open drafts.

Validation for this follow-up: 21 editor/provider/Markdown tests, 259 focused runtime/prompt/eval tests (overlapping the full suite), and all three consumer-memory browser scenarios passed. The broad frontend run passed 10,172 tests with one loopback-binding failure; the complete affected encryption file then passed all 17 tests with local socket access. Shared/scripts completed with 755 passing and 75 sandbox-only failures; rerunning the four blocked socket/Docker files passed all 157 of their tests, including their setup-dependent cases. The 13 e2e helper tests also passed with local socket access. Final TypeScript, production build, formatting, license checks, and scoped ESLint passed (three pre-existing console warnings). Desktop and 390×844 computer-use checks confirmed the Markdown view, gradient selection, edit toolbar, tall editor, and icon-only Copy. This follow-up changed routing and presentation; it did not repeat the paid model evaluation matrix or complete live external provider grants.

## Built-in card and connection lifecycle follow-up

The latest screen places the built-in Markdown preview, Compact, and Edit inside the Built-in provider card. Clicking the card body or View full memory opens a read-only responsive aside; Edit opens the same aside with an exact-content draft. The aside exposes Edit through its standard More menu; editing shows Save and Cancel in the shared footer. Save returns to the styled document, while Cancel preserves saved text. The full document remains copyable through the subtle corner icon. Selection stays independent of viewing/editing, including when an external provider is selected. Turning Saved memories off dims and disables the provider area and any open editor without discarding its draft; Reference earlier chats remains independent.

Computer use verified the new card, full styled document, tall editor, the save/cancel footer, and Cancel in the isolated desktop app. The app remains open on Settings → Memory. The external setup and status panels now share the other connection panels' appearance, with live transport status, Enable, Retry, and cancellation. No external provider accounts or grants were created.

Protocol fixes cover Mem0's canonical trailing slash, advertised OAuth resource audiences through authorization/exchange/refresh, and supported DCR client authentication. Cancellation and enable operations are guarded against stale navigation, account changes, deleted/changed endpoints, and newer authorizations. The focused provider/OAuth suite passed 164 tests; the controller/DAL/callback suite passed 113 tests. These suites overlap and their totals are not additive. Paid model evals were not repeated for this presentation and OAuth lifecycle follow-up. The final broad `bun run test` completed with 11,075 passing tests and no failures: 10,224 frontend, 838 shared/scripts, and 13 e2e unit helpers (37,199 assertions). The final Memory page/menu checks passed 14 tests with 108 assertions; card/connection checks passed 6 tests with 49 assertions. Those focused checks overlap the broad run. All three final consumer-memory browser scenarios passed, including the More → Edit menu, complete raw copy, disabled draft retention, mobile 390×844 editor, final descriptions, full-width divider, provider persistence, and setup validation. TypeScript, production build, localization extraction, formatting, license headers, and scoped lint passed.

The follow-up keeps the aside’s More menu visible during editing, with Edit disabled so it cannot reset a draft. Shared desktop asides now animate only their outer width; removing the simultaneous inner translation reveals content throughout the opening motion. A width keyframe handles lazy panels that first mount already open, and Suspense no longer mounts a temporary animated aside that would be replaced mid-transition. Reduced-motion behavior and existing close guards are retained. Native computer use confirmed the menu remains available in edit mode without changing the document.

Final motion validation passed 30 shared aside tests (112 assertions) and 54 connection tests (256 assertions). Nine Chromium scenarios passed across the final runs: four Memory flows, four model-aside flows, and the shared surface-motion flow. The Memory cold/warm motion case also passed in WebKit. Frame sampling confirmed intermediate widths during opening and closing, monotonic motion, and one stable DOM surface per phase. TypeScript, scoped lint, formatting, and the final production build passed. These focused suites overlap earlier checks and do not replace the limitations on live provider grants and Opus matrix coverage below.

## Reproduction and artifacts

Run `bun run eval:memory` or `bun run eval:memory:compact` with an authorized backend. These make real provider requests. See [the eval README](../../../src/ai/eval/README.md) for filters and credential configuration. Every journal records implementation and prompt fingerprints, fixture input, the actual tool trace, and the resulting document. The local artifacts are gitignored and remain in the implementation worktree.

- Initial document matrix: `evals/memory-document-verified.md` and `.jsonl`
- Corrected fixture/correction follow-up: `evals/memory-document-final-followup.md` and `.jsonl` (59/60; the one CAS efficiency failure prompted revision tokens)
- Final opaque-revision memory matrix: `evals/memory-document-revision.md` and `.jsonl` (78/78)
- Combined current scenario selection: `evals/memory-document-summary.json` and `evals/memory-summary.md` (114/114 across the two identified journals)
- Current freeform compaction: `evals/memory-document-compaction-final.json`
- Historical row-design reports: `evals/memory-verified.*`, `evals/memory-opus-verified.*`, `evals/memory-retrieval-regression.*`, `evals/memory-compaction.json`, and `evals/memory-opus-compaction.json`

The old automated Opus matrix used the exact 5.5 model through OpenRouter. Its temporary exported credential was deleted. Automatic approval review later declined another export, so it was not retried or bypassed; current Opus testing uses the already-connected native app. The managed Anthropic backend transport was unavailable because the local backend has no Anthropic API key.

## Limits

Three model samples per case do not establish perfect future behavior. Actual external-memory account grants were not completed, and no real two-device replication test was performed. The current design uses the existing settings sync/encryption path and does not require the two-PR deployment procedure for a new synced table.
