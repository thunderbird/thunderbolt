# Unified artifacts

Generated HTML and configured Mini Apps are two sources of the same user-facing
artifact. An artifact can be displayed inline, in the content sidebar, or in a
full-page workspace with a conversation beside it. Pinning determines which
artifacts appear in the navigation sidebar; it does not determine whether they
exist or which display they use.

## Decisions and invariants

1. **Reference content, do not duplicate it.** Generated content remains the
   verified `render_html` input in its original message. A remote artifact
   remains an entry in the validated backend registry. A pin is a bookmark,
   not an independently saved copy: deleting its source chat makes that
   artifact unavailable. This avoids competing versions, extra reconciliation,
   and a new synced entity with a separate deployment lifecycle.
2. **One stable identity.** HTML references use the message ID and tool-call ID;
   remote references use the configured app ID, in a separate namespace.
   Titles, array positions, and the currently focused chat are never identity.
   Full-page URLs resolve this identity directly, independently of pin state.
3. **Pins are user preferences.** Each reference has its own synced settings
   row. Unpinning writes an explicit false value. There is no shared array that
   loses unrelated concurrent edits, and no hard delete. Settings already sync,
   encrypt their values, and participate in backup/import. Display state is
   local and transient, like the existing content sidebar.
4. **The host is shared; execution boundaries are source-specific.** HTML is
   still verified before execution, uses an opaque-origin `srcdoc` sandbox,
   and cannot make network requests under its offline CSP. Remote apps retain
   exact source/origin checks, their separate origin, token capabilities,
   tool approvals, and bounded bridge requests. Pinning grants no authority.
5. **One owner for the assistant's active surface.** Each mounted renderer has
   an instance owner. Activation is explicit, and cleanup removes only that
   owner. A background inline frame must not displace a deliberately opened
   panel. Closing a surface can reveal the previously active mounted surface.
   Remote tools and context must belong to the same active surface.
6. **One full-page workspace.** Both source adapters use the existing tested
   conversation panel lifecycle: drafts remain local until persisted, existing
   chats live in the URL, and opening a conversation never discards another.
   Existing `/apps/:appId` links continue to work. The existing textual
   `mini_app_id` provenance field retains raw IDs for configured apps and can
   carry canonical HTML artifact IDs for generated artifacts; no schema change
   or data backfill is needed.
7. **Availability is not a loading error.** A failed registry fetch must not
   claim that an app was deleted. Generated HTML resolves offline without
   waiting for the registry. Failed, incomplete, or deleted HTML is never
   promoted into an executable artifact by pinning or navigation.

## Implementation sequence

1. Add the canonical source model, verified resolver, pin DAL and live queries.
2. Extract shared rendering and session ownership while preserving the two
   sandbox adapters and the remote bridge's approval/authentication behavior.
3. Use shared controls and surfaces in the transcript and content sidebar.
4. Extract the common full-page workspace; add the artifact surfaces, pinned
   navigation, direct routes, and compatible chat provenance.
5. Verify the integrated lifecycle, update localization and architecture docs,
   and run static checks plus source, UI, and browser regression suites.

Moving between separate hosts (transcript, content sidebar and workspace)
remounts the frame, as the existing inline/sidebar toggle does. Within the
workspace, changing panel proportions or viewport size keeps both the iframe
and conversation mounted. Generated HTML source and pins persist; in-memory JavaScript state
inside a frame does not. Runtime-state persistence would require a separate,
explicit guest protocol and is not implied by a bookmark.

## Verification matrix

| Concern           | Required coverage                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------- |
| Identity          | Duplicate titles/call IDs, multiple parts, encoded route IDs, source namespaces              |
| Resolution        | Typed/MCP/ACP output, invalid/failed/streaming calls, deleted messages and threads           |
| Pins              | Pin/unpin/re-pin, durable readback, independent writes, no copied HTML, missing sources      |
| Displays          | Both sources inline/sidebar/full-page, transitions, reload/deep links, source-chat quotes    |
| Ownership         | Multiple mounted frames, explicit activation, old cleanup, restoring the underlying surface  |
| Remote regression | Origin/source validation, auth, navigation, live context, write approvals, downloads         |
| HTML regression   | Scripts-off previews, verification, offline CSP, opaque origin, nonce validation             |
| Chat lifecycle    | New/persisted URL transitions, reopen/history, legacy app links, unavailable source fallback |
| Quality           | Scoped Bun suites, TypeScript, lint, formatting, catalog extraction, real-browser harness    |
