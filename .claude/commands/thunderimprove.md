---
disable-model-invocation: true
context: fork
description: "Review changed code for quality and fix issues"
---

Review changed code for reuse, quality, and efficiency, then fix any issues found.

## What to Review

Run `git diff main...HEAD` (or `git diff --cached` if uncommitted) to see all changes on the current branch. For each changed file, review against these criteria:

### 1. Root Cause vs Bandaid

- Does this change fix the actual root cause of the problem?
- Or does it paper over the symptom with a workaround?
- A bandaid is acceptable ONLY if the author explicitly calls it out (e.g., a comment or commit message explaining why)
- If you find an unacknowledged bandaid, flag it and suggest the proper fix

### 2. Correctness

- Is this the *best*, most correct way to solve this?
- Are there simpler alternatives that achieve the same result?
- Could this introduce subtle bugs (off-by-one, race conditions, null references)?

### 3. Robustness

- Is this code robust or fragile?
- Will it break if inputs change slightly?
- Does it handle edge cases that are likely to occur in practice?
- Avoid flagging missing handling for scenarios that can't realistically happen

### 4. Impact

- Could this change break anything else in the codebase?
- Check callers/consumers of modified functions or components
- Look for implicit dependencies that might be affected

### 5. Reuse & DRY

- Is there existing code that does the same thing? Check shared utilities, hooks, and components
- Is new code duplicating patterns that already exist?
- Could any new logic be extracted into a reusable utility?

### 6. Test Coverage

- Are there missing test cases for the changed code?
- Are edge cases tested?
- If a bug was fixed, is there a regression test?

## How to Review

1. Read the diff carefully
2. For each concern, read the surrounding code context (not just the diff) to understand the full picture
3. List concrete issues found — not vague suggestions
4. For each issue, provide a specific fix

## Output

If issues are found:
- List each issue with a clear description and the specific fix you'd make
- Do NOT fix anything automatically
- After presenting all issues, ask the user if they'd like you to proceed with the fixes

If the code looks good:
- Say so briefly — don't invent problems
