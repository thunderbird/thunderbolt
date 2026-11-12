# Style Exemplars (anonymized) — match this register

Few-shot exemplars distilled from real held-out reviews, paraphrased and de-identified. They encode the **bar**, not any person. Format: signal → finding (in-register) → severity. Match the voice: lead with a question/first-person framing, name the tier, prescribe the fix.

1. **Signal:** a new backend route proxies one provider in parallel to the existing `/chat`/`/inference` path.
   **Finding:** "I'd think of this as another model provider on the existing chat endpoint rather than a separate backend integration — that's where we'd centralize token tracking later. Can the encrypted body ride the one canonical endpoint instead? Prefer a single chat path for all providers." → *Future-pain / architecture (block).*

2. **Signal:** code references `M4` / `external-6` / a bare flag with no explanation.
   **Finding:** "What is `M4` here? There's no rationale in the code or nearby — can we name it or add a comment so the intent survives?" → *Docs-intent (warning, question).*

3. **Signal:** a hardcoded array enumerating every model ever shipped, used to filter defaults.
   **Finding:** "Over time this list gets really long and bloats the bundle — hate to grow it. Could we derive it instead (e.g. remove any unedited system model not in the current defaults) rather than enumerating removed ones?" → *Bloat (block-ish, architectural).*

4. **Signal:** `const FOO_BAR = …` / ALL_CAPS keys in a frontend `.ts`/test file.
   **Finding:** "These should be camelCase to match the codebase — the ALL_CAPS convention only applies to wire/JSON string values, not our TS identifiers." → *Convention (R-CAMEL).*

5. **Signal:** `try { ok() } catch (e) { console.warn(e) }` around a trusted call.
   **Finding:** "Let's not swallow this — prefer letting it throw so we catch it in dev. Swallowed errors tend to come back to haunt us." → *Error-handling (R-ERRSWALLOW, block).*

6. **Signal:** a component with 4+ `useState`.
   **Finding:** "This is a lot of `useState`s — would a `useReducer` make it less bug-prone and easier to follow?" → *React (R-REDUCER, convention).*

7. **Signal:** a test leans on `mock.module(...)` of an internal collaborator.
   **Finding:** "I'd love to avoid mocking our own modules here — it's usually a sign the code wants dependency injection. Could we inject the dependency instead, or at least note why the mock is unavoidable?" → *Testability (R-NOMOCK).*

7a. **Signal:** a new test file does `mock.module('@/hooks/use-settings', () => ({ useSettings: () => ({ … }) }))` (a shared module).
    **Finding:** "This is a blocker — `mock.module()` on a shared module like `@/hooks/use-settings` leaks globally to every test file in the worker. It'll pass alone and then fail in CI when run together (`undefined is not an object`, `Export named 'X' not found`) — the #1 CI-flake here. Don't mock it better; drop the mock and use the real hook with a test DB/provider (`setupTestDatabase` + `createTestProvider`)." → *Testability (R-NOMOCKSHARED, block).*

7b. **Signal:** a test mocks `@/components/ui/dialog` but lists only `Dialog`/`DialogContent`, omitting `DialogFooter`.
    **Finding:** "If we truly must mock a shared module, it has to include EVERY export — a missing `DialogFooter` here will crash the next test file that imports it (`Export named 'DialogFooter' not found`). Better: don't mock the shared UI module at all." → *Testability (R-NOMOCKSHARED, block).*

8. **Signal:** a one-off `useAnonymousSessionGuard` hook gates auth alongside the existing `AuthGate`.
   **Finding:** "This feels like a footgun — anonymous auth is just another auth type, so I'd fold it into `AuthGate` rather than a separate guard/hook. If someone later removed the other gate they might not realize this silently creates users. Could we do it imperatively in the auth logic?" → *Architecture / footgun (block).*

9. **Signal:** a branch handles `isAnonymous && !isAuthenticated`.
   **Finding:** "How is it possible for a user to be anonymous *and* not authenticated? This branch looks unreachable — can we remove it or correct the condition?" → *Correctness / dead code (warning).*

10. **Signal:** a switch adds one new model/provider case; siblings exist nearby.
    **Finding:** "Should the other three models be added here too? Want to make sure this isn't half-applied." → *Completeness (question).*

11. **Signal:** a flicker/ordering bug is patched with `setTimeout(() => …, 0)`.
    **Finding:** "I'm skeptical of the `setTimeout` here — it papers over an ordering bug rather than fixing it. Does fixing the branching remove the need for the timer?" → *Error-handling (block).*

12. **Signal:** a frontend flow calls `db.delete()` on a user-data row.
    **Finding:** "We always soft-delete on the frontend — set `deletedAt` instead of hard-deleting, unless this is an explicit account/device removal." → *Data (R-SOFTDEL, block).*

13. **Signal:** a `deps` object bundles two collaborators passed into a function/hook.
    **Finding:** "The `deps` object feels heavier than needed — deps are just inputs; I'd keep them flat as plain args, it reads easier." → *Readability (nit/idea).*

14. **Signal:** a non-nullable column is added to a synced PowerSync table.
    **Finding:** "We need these synced columns nullable — a non-nullable add breaks sync for existing rows. Also confirm the two-PR deploy (backend + `config.yaml` rules before the frontend)." → *Hard block (R-SYNCNULL).*
