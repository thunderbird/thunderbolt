# Review: PROPOSAL-001 — Fix Google Connect on Desktop (THU-302)

**Reviewer:** Team Lead
**Date:** 2026-02-25
**Status:** APPROVED WITH CORRECTIONS

---

## 1. User Stories

### Clarity and Testability

All five user stories are clear and testable.

- US-001 through US-003 map directly to the loopback flow and have specific, binary acceptance criteria (no error 400, email shown, tokens persisted, system browser opens, connecting state clears, cleanup guaranteed).
- US-004 (mobile unchanged) and US-005 (web unchanged) are correctly scoped as regression guards, not new behavior.
- AC-003-5 (15-second timeout for abandoned browser) correctly acknowledges the existing timeout mechanism without mandating changes to it. The open question about extending the timeout to 5 minutes for the desktop branch is appropriately deferred.

**Verdict: PASS.**

---

## 2. Scope

### In Scope

The scope table is accurate and complete. The following items are correctly included:

- New npm dependency + Rust crate
- New `src/lib/oauth-loopback.ts`
- Deletion of `src/lib/oauth-webview.ts` and `src-tauri/capabilities/auth.json`
- Signature changes to `google/auth.ts`, `microsoft/auth.ts`, `src/lib/auth.ts`
- Hook swap in `use-oauth-connect.ts`
- Tauri capabilities update
- Unit test file and hook test updates

### Out of Scope

Mobile flow, backend changes, Cloud Console configuration, Microsoft Entra registration, new UI, and retry logic are all correctly excluded.

**CORRECTION — `src/lib/oauth-redirect.ts`:**

The proposal's scope table lists "Update `src/lib/oauth-redirect.ts`" as in scope. However, the architecture (RESEARCH-001, Section 5) and the oauth-loopback contract both explicitly state that `oauth-redirect.ts` requires NO changes. The loopback flow constructs its own `redirectUri` from the port number and bypasses `getOAuthRedirectUri()` entirely. The proposal's own Technical Design section (under "Changes to `src/lib/oauth-redirect.ts`") also contradicts the scope table — it describes the change as removing the desktop Tauri branch, but RESEARCH-001 says "No changes. The loopback flow bypasses `getOAuthRedirectUri()` entirely."

**Decision: `src/lib/oauth-redirect.ts` is OUT OF SCOPE. Do not modify it. It is not needed. The contracts are authoritative on this point.**

**Verdict: PASS with one correction (oauth-redirect.ts removed from scope).**

---

## 3. Parallelizability

The work splits cleanly along a dependency boundary:

- `oauth-loopback.ts` depends on the updated signatures in `auth.ts` (Implementer-2's work), but only at the TypeScript type level. The function signatures are a pure additive change (optional `redirectUri?` param). Implementer-1 can write the new file against the final signature from day 1 because the signature is fully specified in auth-signatures.md.
- `use-oauth-connect.ts` changes are a search-and-replace operation (webview → loopback). These depend on `oauth-loopback.ts` existing, but only to import its type for the `OAuthDependencies` typedef. If Implementer-1 and Implementer-2 work in the same branch or if the loopback module skeleton is stubbed, these can proceed in parallel.
- Rust/Tauri changes (Cargo.toml, lib.rs, capabilities) are independent of all TypeScript work.

Parallelization is feasible. Task split is defined in the consensus document.

**Verdict: PASS.**

---

## 4. Contract Precision

### oauth-loopback.md

Excellent precision. The contract specifies:
- The exact exported function signature with JSDoc
- All internal constants including the 3-port array `[17421, 17422, 17423]`
- The `completionHtml` constant with required `<head>` element note
- The `Promise.withResolvers` pattern for clean linear flow
- The strict ordering requirement: `onUrl` must be registered BEFORE `openUrl`
- The 5-minute timeout via `Promise.race`
- All imports with exact package names
- Error handling table covering all failure modes
- Explicit note that `cancel()` failure is silently caught in finally

**One ambiguity in the contract:** The pseudocode section (lines 69–79) contains a draft/broken version of the flow before the "Refined Implementation Pattern" section at line 119 supersedes it. An implementer reading carefully will use the refined pattern, but the broken draft could cause confusion. The consensus document calls this out.

### use-oauth-connect.md

Precise to the line number. The diff format is unambiguous. All three unchanged branches are explicitly called out.

### auth-signatures.md

Precise. Backward compatibility table is thorough. The `satisfies` constraint note is correct.

### rust-tauri.md

Precise. The critical distinction between `oauth:allow-start`/`oauth:allow-cancel` vs. `oauth:default` is explicitly called out with the verification source. The webview permission analysis correctly identifies which to remove and which to keep.

**Verdict: PASS.**

---

## 5. Critical Finding: `oauth:allow-start` + `oauth:allow-cancel` vs. `oauth:default`

**The Architect's finding is correctly propagated to the rust-tauri.md contract.** The rust-tauri contract states explicitly (lines 53–57):

> Note: The plugin does NOT define an `oauth:default` permission set. Both commands must be listed individually. This was verified by inspecting the plugin's `permissions/autogenerated/` directory, which only contains `commands/start.toml` and `commands/cancel.toml`.

The PROPOSAL-001 scope table (line 130) references `oauth:default` — this is WRONG and contradicts the architecture. The contract is the authoritative source and is correct. The proposal's scope table entry must be treated as superseded.

**This is a showstopper if not corrected.** Using `oauth:default` in capabilities will fail because it does not exist in the plugin. The correct permissions are `oauth:allow-start` and `oauth:allow-cancel` individually.

**Verdict: FOUND AND CORRECTED in contracts. The proposal's scope table has the wrong permission name. Implementer-2 must use the contract, not the proposal's scope table.**

---

## 6. Gaps, Contradictions, and Ambiguities

### CONFIRMED BUG: `listen('oauth://url', ...)` in PROPOSAL-001

The proposal's Technical Design section (lines 210–211 of PROPOSAL-001) uses:

```typescript
listen<string>('oauth://url', (event) => {
  const url = new URL(event.payload)
```

This is WRONG. The plugin does not emit a raw Tauri event that callers subscribe to with `listen()`. The correct API is `onUrl(callback)`, which is a typed wrapper provided by the plugin's guest bindings. `onUrl` registers the listener internally and returns an unlisten function. The `listen('oauth://url', ...)` pattern would require importing `listen` from `@tauri-apps/api/event` and would NOT work correctly — the plugin's event emission mechanism is internal.

The oauth-loopback.md contract correctly uses `onUrl`. **Implementers must follow the contract, not the proposal skeleton.**

### Contradiction: `oauth-redirect.ts` in Scope Table

As noted above, the proposal scope table includes `oauth-redirect.ts` but the architecture and contracts explicitly exclude it. Contracts win.

### Contradiction: `http:allow` loopback entries

The proposal (line 411–414) suggests adding loopback URLs to the `http:allow` list in `default.json`. The rust-tauri.md contract does not mention this. The loopback server runs on `127.0.0.1` and the app itself connects to it only indirectly via the plugin's internal mechanism — there is no `ky` or `fetch` call from the app to `http://127.0.0.1:1742x`. The system browser handles the redirect; the plugin's Rust thread captures it. No `http:allow` entry for the loopback ports is needed in `default.json`. The contract is correct in omitting this.

### Minor Ambiguity: `oauth-loopback.md` pseudocode section

The contract contains a broken/draft pseudocode block (lines 69–79) that shows `Promise.race([... no timeout])` as a note to restructure. This is superseded by the Refined Implementation Pattern at line 119. Implementer-1 should skip to the Refined Implementation Pattern section and ignore the draft.

### Minor Ambiguity: `redirectUri` format — `http://localhost:` vs `http://127.0.0.1:`

The proposal uses `http://127.0.0.1:${port}` in the `redirectUri`. The architecture (RESEARCH-001) uses `http://localhost:${port}` in the flow description and the Cloud Console registration list. The contracts (oauth-loopback.md line 63) use `http://localhost:${port}`. Google accepts both `127.0.0.1` and `localhost` for loopback, but they must exactly match what is registered in the Cloud Console.

**Decision: Use `http://localhost:${port}` as specified in the contract. The Cloud Console registrations must use `http://localhost:1742x` (not `127.0.0.1`). This is the contract's authoritative value.**

---

## 7. Summary Verdict

| Criterion | Result |
|---|---|
| User stories clear and testable | PASS |
| Scope realistic, no creep | PASS with one correction (oauth-redirect.ts out) |
| Parallelizable | PASS |
| Contracts precise enough to implement | PASS (with note about broken pseudocode in oauth-loopback.md) |
| `oauth:allow-start`/`oauth:allow-cancel` finding in contracts | PASS — correctly in contracts; proposal scope table is wrong |
| Gaps/contradictions resolved | PASS — all resolved in favor of contracts over proposal |

**Overall: APPROVED WITH CORRECTIONS. Proceeding to consensus.**
