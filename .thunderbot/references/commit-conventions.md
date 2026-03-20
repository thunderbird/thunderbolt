# Commit Conventions Reference

Rules for writing atomic, conventional commits in the Thunderbolt project. Used by `/thunderpush` and during ThunderBot's autonomous workflow.

---

## Format

```
type(THU-123): short description

- optional body with details
- another detail
```

The **scope** (parenthesized part) is used ONLY for Linear ticket IDs. Never use it for component or module scoping.

If there is no Linear ticket, omit the scope:

```
type: short description
```

---

## Commit Types

| Type | Purpose |
|------|---------|
| `feat` | New feature or capability |
| `fix` | Bug fix for a bug that existed on main |
| `docs` | Documentation changes |
| `style` | Code style/formatting (no logic changes) |
| `refactor` | Code restructuring (no behavior changes) |
| `perf` | Performance improvements |
| `test` | Test additions or updates |
| `chore` | Maintenance, dependency updates, config |
| `build` | Build system or tooling changes |
| `ci` | CI/CD pipeline changes |
| `revert` | Revert a previous commit |

---

## Critical Rule: When to Use `fix:`

**`fix:` is ONLY for bugs that existed on main before the current branch.**

If you are fixing something you introduced on the current branch (e.g., addressing PR review feedback, fixing a test you broke, correcting a typo in new code), use:

- `chore:` for cleanup and minor corrections
- `refactor:` for restructuring code you wrote
- The original type (e.g., `feat:`) if you are completing incomplete work

This distinction matters because `fix:` commits signal to tooling and changelogs that a user-facing bug was resolved.

---

## Quality Rules

- **Imperative mood**: "add feature" not "added feature" or "adds feature"
- **Lowercase**: Description starts with a lowercase letter
- **No period**: Do not end the subject line with punctuation
- **Under 72 characters**: Subject line must be concise
- **Present tense**: "add" not "added", "fix" not "fixed"
- **Focus on why**: The body explains motivation, not mechanics

---

## HEREDOC Format

Always use HEREDOC for `git commit` to handle multi-line messages and special characters:

```bash
git commit -m "$(cat <<'EOF'
type(THU-123): short description

- detail about what changed and why
- another detail
EOF
)"
```

---

## Atomic Commits

One logical change per commit. If changes span unrelated concerns, ask whether to split into multiple commits.

Examples of atomic boundaries:
- A feature and its tests = one commit
- A refactor that enables a feature = separate commit from the feature itself
- A bug fix and an unrelated style change = two commits

---

## Git Safety

- **Never amend** existing commits
- **Never force push** -- not even to feature branches
- **Never skip hooks** (`--no-verify`) -- if pre-commit fails, fix the issue and create a new commit
- **Never manually run** `git add`, `git commit`, or `git push` -- always use `/thunderpush`

---

## When to Analyze Diffs

**Skip `git diff`** when:
- File paths clearly indicate the change purpose
- The user has described what changed
- A single focused modification is obvious

**Use `git diff`** when:
- Changes span multiple features or concerns
- Determining logical groupings for multi-commit scenarios
- The nature of modifications is not clear from file names

**Use `git diff main`** when:
- Working in a feature branch with many commits
- Need to understand cumulative changes since branching

---

## Good Examples

```
feat(THU-303): add email notification preferences

- add NotificationPreferences component with toggle controls
- wire up to existing user settings API
```

```
fix(THU-287): prevent duplicate form submissions on slow connections
```

```
refactor: extract validation logic into shared utility
```

```
chore(THU-303): address PR review feedback

- rename variable per reviewer suggestion
- add missing null check
```

```
test(THU-310): add edge case tests for date parsing
```

## Bad Examples

```
feat(auth): Added new authentication method.
# Bad: scope is a module name (should be ticket ID), past tense, ends with period
```

```
Fix: Fixes the bug with null values
# Bad: capitalized type, capitalized description, redundant wording
```

```
added feature
# Bad: missing type prefix, past tense
```

```
feat: this adds a new component for displaying user data in the sidebar panel
# Bad: verbose, uses "this adds" instead of imperative "add"
```

```
fix(THU-303): fix typo in new component
# Bad: uses fix: for something introduced on the current branch -- should be chore:
```
