# Weekly docs audit

Once a week an agent checks the docs against the code and opens a PR with its fixes. A person reviews and merges
it; the workflow never merges or approves.

The workflow is `.github/workflows/docs-audit.yml`. It runs on Mondays at 06:00 UTC, and by hand with
`workflow_dispatch`. It does nothing until the `DOCS_AUDIT_ENABLED` repository variable is `true`.

## What it reads

The audit may edit Markdown under `docs/` and every `AGENTS.md` (each `CLAUDE.md` is a symlink to or an import of
its `AGENTS.md`). Each run covers two things, picked by
`.github/scripts/docs-audit-select.ts`:

- **Changes:** commits on `main` from the last 7 days. Lockfiles, translation catalogs and the generated wasm package
  are filtered out. The agent finds the docs each commit made wrong, and adds coverage for new user- or
  operator-facing behaviour.
- **Rotation:** a quarter of the docs, chosen by ISO week number, read in full and checked claim by claim. Every
  doc gets a full review every 4 weeks.

`isInScope` in that script is the one definition of a doc: the patch is a diff of exactly that list, and the publish
job checks it again with the same function. The agent's instructions are in `prompt.md`. It writes `docs-audit-out/summary.md`, which becomes the PR body: each
fix with its evidence, plus anything it suspects is a code bug or could not decide.

## Trust zones

| Job       | Holds                                                     | Does                                                                                                                                     |
| --------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `audit`   | `QA_ANTHROPIC_API_KEY`, a read-only token                 | Runs the agent with reads limited to the checkout and edits limited to the docs. No shell, no web, no git                                |
| `publish` | `QA_APP_CLIENT_ID`, `QA_APP_PRIVATE_KEY` (live runs only) | Runs no model. `docs-audit-check-patch.ts` refuses a patch that touches anything but docs; then it builds the docs site and opens the PR |

Both jobs use the `qa-agent` environment and reuse the QA agent's secrets (see `.github/qa/README.md`). The app
token is limited to this repository with `contents: write` and `pull-requests: write`. A PR opened by the app runs
CI; one opened with `GITHUB_TOKEN` would not.

Each live run pushes a new branch, `docs-audit/YYYY-MM-DD`, so it never overwrites commits a reviewer added to an
earlier audit PR. Close a stale audit PR when a newer one supersedes it.

## Run it by hand

```sh
# Review one doc and show the patch in the run summary
gh workflow run docs-audit.yml -f dry_run=true -f docs=docs/self-hosting/configuration.md

# This week's rotation, opening a PR (only from main)
gh workflow run docs-audit.yml -f dry_run=false
```

A dispatch opens a PR only when `dry_run` is false and the run is on `main`. The schedule always opens one when it
finds something.

## Caps

`DOCS_AUDIT_MAX_BUDGET_USD` and `DOCS_AUDIT_MAX_TURNS` in the workflow's `env` cap each session. A session that hits
a cap fails the job, and nothing is published. If that happens often, raise the cap or shrink the rotation
(`rotationWeeks` in the select script).
