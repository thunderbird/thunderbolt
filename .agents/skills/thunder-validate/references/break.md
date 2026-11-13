# Try to break it

Contents: scope; attacks from the diff; attack families; budget; verdicts; origin check on main; report.

Run this after the normal checks pass or fail, on a new implementation only: a PR, ticket or
branch that adds or changes behaviour. Use the same stack, platforms, disposable accounts and
evidence rules as the matrix. The goal is a counterexample: an input or sequence that makes the
new code crash, lose or corrupt data, expose data, take the wrong route or get stuck.

## 1. Attacks from the diff

Read the diff and list every new behaviour. Each of these is one entry:

- every new or changed branch: `if`/`else`, `switch` case, guard, early return, ternary;
- every error path: `catch`, error response, fallback, retry, timeout, empty result;
- every new state: stored value, setting, status, flag, column, cache entry, UI mode.

For each entry write the input or sequence that takes the wrong branch, reaches the error path or
leaves the state inconsistent. These attacks come first. Done when every entry has at least one
attack or a one-line reason it cannot be reached from the running app.

## 2. Attack families

Fill the remaining attempts from these families, choosing what the change makes likely:

- **Limits:** empty, whitespace-only, very long, emoji/RTL/combining characters, pasted rich text,
  zero, negative, maximum sizes, many items, a slow or dropped network, offline mid-action.
- **Timing:** double click/submit, cancel mid-stream, navigate away mid-request, reload during a
  save, two tabs or two devices at once, retry after a timeout, app backgrounded or killed on mobile.
- **State:** fresh account versus existing data, signed out or session expired mid-flow, data
  written by an older version, a setting or feature flag toggled during the action.
- **Thunderbolt invariants:**
  - soft delete: a deleted item disappears from lists, search and the other device, and the row
    keeps `deletedAt` instead of vanishing (account and device removal are the hard-delete exceptions);
  - sync: an edit on device A reaches device B, an offline edit survives reconnect, concurrent edits
    converge (needs Postgres + PowerSync, see stack.md);
  - E2EE device approval: an unapproved device cannot read encrypted data and a revoked device loses
    access;
  - 426 app-version gate: with `MIN_APP_VERSION` above the build (restart the backend after setting
    it), the new requests get 426 and the app shows its upgrade path, while exempt routes still work;
  - proxy vs direct: with Cloud Proxy ON and OFF the new requests take the route current code
    predicts, proven as in evidence.md's routing section.
- **Security basics:** HTML and `<script>` in every new text field render as text; every new
  screen or route opened signed out redirects to sign-in; a second disposable account cannot read
  the first account's data by changing ids in URLs or requests. Deeper E2EE attacks belong to the
  `thunder-red-team` skill; name them as follow-ups instead of running them here.

## 3. Budget

About three attempts per new behaviour, diff-derived first. Stop at 30 minutes of attack time
(setup and the origin check excluded) and list the untried attacks in the report. A one-line change
gets a handful of attempts; a new feature gets the full ceiling.

## 4. Verdicts

Give every attempt exactly one verdict:

- **BROKE:** the app did the wrong thing. Needs two reproductions from clean conditions (fresh
  reload, profile or account as the attack requires), with steps, impact and evidence. A single
  sighting is BLOCKED with the reason "seen once, not reproduced".
- **HELD:** the app handled it; cite the assertion and evidence.
- **BLOCKED:** the attack could not run; name the missing platform, credential or tool.

## 5. Origin check on main

For each BROKE, decide whether this change introduced it:

- The broken behaviour also exists on main: rerun the same attack on main, same platform, in its own
  snapshot of `origin/main` with its own stack (record both in the cleanup ledger). Label the item
  **introduced by this PR** when main holds and **pre-existing** when main breaks the same way.
- The behaviour is 100% new (main has no equivalent path): skip the rerun and label it
  **introduced by this PR (new code)**.
- Mixed change: rerun only the part that exists on main; the new part takes the new-code label.

## 6. Report

Add a "Break attempts" section after the matrix, in the user's language:

```markdown
| Behaviour (file:line) | Attack | Platform | Verdict | Origin | Evidence / steps |
|---|---|---|---|---|---|
| ... | ... | ... | BROKE/HELD/BLOCKED | introduced / pre-existing / new code / – | ... |

Attempts: N (BROKE x: introduced y, pre-existing z; HELD n; BLOCKED m). Untried for budget: ...
E2EE follow-ups for thunder-red-team: ...
```

Every BROKE also goes in the confirmed issues list with steps and impact. Break verdicts stay out
of the matrix counts; a BROKE on a scoped acceptance check also turns that matrix row FAIL.
