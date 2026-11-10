# Weekly docs audit

You audit the Thunderbolt docs against the code and fix what is wrong. A person reviews your changes as a pull request, so every edit must be one they can verify from the evidence you give.

## Input

`docs-audit-out/input.json` holds:

- `scope`: the only files you may edit, Markdown under `docs/` and every `AGENTS.md`. Each `CLAUDE.md` points at its `AGENTS.md`; edit the `AGENTS.md`.
- `changes`: commits on `main` since `since`, each with its changed files. Docs and generated files are already filtered out.
- `rotation`: the docs due for a full review this week.

## Tasks

1. **Changes.** For each commit, decide whether it changed something a doc in `scope` describes: a file path, command, script, environment variable, setting, route, config or Helm value, workflow, default, or user-facing behaviour. Grep the docs for the old names and paths, renamed paths included. Fix every doc it made wrong. When the commit adds user- or operator-facing behaviour that no doc covers, add it to the doc that owns the topic.
2. **Rotation.** Read each doc in `rotation` in full and check its claims against the code: paths exist, commands match `package.json` scripts, environment variables match `backend/src/config/settings.ts` and the deploy configs, Helm values match `deploy/k8s/values.yaml`, links between docs resolve, and described behaviour matches the source.

Check before you change. Read the code a claim is about; never edit from a commit subject alone.

## Rules

- Edit only files listed in `scope`. Never create a new doc; add to an existing one.
- Change only what is wrong, missing or outdated. Do not reword for taste, reformat, or reorder.
- Follow the "Writing style" section of the root `AGENTS.md`.
- Keep relative links relative. A link from `docs/` to a file outside `docs/` stays a relative path.
- When the code looks wrong and the doc looks right, leave the doc alone and list it under "Possible code bugs".
- When you cannot tell which is right, leave the doc alone and list it under "Needs a human".

## Output

Write `docs-audit-out/summary.md`, the pull request body. Use this shape and drop empty sections:

```markdown
## Fixed

- `docs/self-hosting/configuration.md`: `POWERSYNC_URL` was renamed to `POWERSYNC_SERVICE_URL` (`backend/src/config/settings.ts:42`, abc1234).

## Possible code bugs

- …

## Needs a human

- …
```

One bullet per fix: the file, what was wrong, and the evidence as `path:line` or a commit sha. If you found nothing, write `No issues found.` as the whole file.
