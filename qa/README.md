# Weekly exploratory QA

Once a week an AI agent uses the web app the way a person would. It works through one **charter** per session
(a short list of things to try, in `charters/`). When something breaks, it writes a finding and a Playwright
spec that fails because of the bug. Plain code then replays each spec, asks a second model whether the finding
is real, and files the confirmed ones in Linear. It can also hand a few of them to a fix agent that opens draft PRs.
The workflow never merges, approves or marks anything ready.

The workflow is `.github/workflows/qa-weekly.yml`. It runs on Mondays at 07:00 UTC, and by hand with
`workflow_dispatch`. It does nothing until the `QA_AGENT_ENABLED` variable is `true`.

## Trust zones

The explorer reads untrusted pages, so everything it writes is untrusted too. Each job holds only the secret it needs.

| Zone                  | Jobs                         | Holds                                                                                        | Never holds                                                                                   |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A: explore and verify | `explore`, `replay`, `judge` | the QA Anthropic key (explore, judge); QA provider keys in the backend process of c3/c5 only | Linear key, any write token. `replay` holds **no secret at all**: it runs model-written specs |
| B: file               | `file`                       | the QA Linear key                                                                            | an LLM, a browser                                                                             |
| C: fix                | `fix`, then `publish`        | `fix`: the QA Anthropic key, read-only token. `publish`: GitHub App token + Linear key       | `publish` runs no LLM and checks the patch in code                                            |

Only the `build` job saves caches, because it runs before any untrusted code. The judge runs in a fresh job,
because the replayed specs may have changed files in the replay job's checkout.

The browser tools can write files anywhere in the explore job's checkout, so no repo code runs there after the
explorer. The stack is killed inline from pid files outside the checkout (`$RUNNER_TEMP/qa-stack.pid*`). A
`sha256sum` check of every tracked file must pass, or the job fails and uploads nothing. The session metrics are
computed later, in the report job. The explore and fix agent steps set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so
no command they start sees the Anthropic key.

Never add `--allow-unrestricted-file-access` to `mcp.json` or set `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS`.
The MCP blocks `file:` URLs by default, and that block keeps local files out of the explorer's reach.

## Pipeline and files

1. **build**: three frontend builds (normal, onboarding on for c1, canaries planted), then the **guard**: a fresh
   stack must pass `control/repro/stack.spec.ts`, or the run stops and `notify-on-failure` fires.
2. **explore**: one job per charter with `claude-code-action` and the Playwright MCP (`mcp.json`,
   `mcp-two-devices.json` for c7). The prompt is `prompt.md` followed by the charter. The explorer writes
   `qa-out/<charter>/findings/<n>.json` and `repro/<n>.spec.ts` as soon as it finds each bug, so a cut session
   keeps what it found. The job uploads only the counters of the session's result message; the report job turns
   them into `session.json` with `scripts/qa/report.ts session`.
3. **replay** (`scripts/qa/verify.ts replay`): schema check, oracle check (`noise.txt` turns console noise into
   observations), spec lint, then every spec runs 3 times (`playwright.qa.config.ts`) next to the control spec.
   3 of 3 failures = confirmed, 1 or 2 = flaky (report only), 0 = dropped.
4. **judge** (`verify.ts judge`): one fresh Opus call per confirmed finding with `judge.md` and `known-issues.md`.
   The default answer is drop. Writes `verified.json`.
5. **file** (`scripts/qa/file-findings.ts`): fingerprint, dedupe against Linear, severity from a table in code,
   at most 8 new tickets plus one roll-up, secret refusal, video upload. Dry run unless `--live`.
6. **fix** (off by default): `scripts/qa/fix.ts route` picks at most 3 tickets in fixable areas. The fix agent
   (`fix.md`) writes a patch without git. A step without secrets then replays the original spec 3 times on the
   patched code. A session that did not finish, or a spec that still fails, becomes a diagnosis, so the ticket goes
   to a person. `fix.ts publish` rejects paths it does not allow, edited specs and empty patches, then opens a draft PR on
   `qa-fix/<fp>`, or labels the ticket `human required`. `preview-deploy.yml` deploys no preview for `qa-fix/*`
   PRs; a maintainer can still dispatch one.
7. **report** (`report.ts summary`): the job summary with sessions, coverage, gate yield, the drop list,
   what was filed, canary recall and the calibration table.

The **canary leg** runs c8 against a build with the planted bugs in `canaries/` (`canaries.json` describes them).
Its findings replay on the canary build, then again on the normal build. A canary counts as found only when its
finding fails on the canary build, passes on the normal build and mentions that canary's keywords.
Canary findings are never filed.

Run-time output goes to `qa-out*/` (gitignored). `fixtures/` holds the PDF and image the charters upload.

## Run it locally

Everything runs from the repo root. The stack uses fixed ports (1424, 1425, 8005, 9878, 9879), so stop any
`bun run e2e` first. Use a production build: the Vite dev server reloads pages while Playwright writes traces.

```sh
# Builds (about 3 s each)
scripts/qa/stack.sh build qa-dist
scripts/qa/stack.sh build qa-dist-onboarding onboarding   # only for c1

# The stack: fake AI, pglite, the normal build on 1424 and the onboarding build on 1425. Leave it running.
scripts/qa/stack.sh serve qa-dist qa-dist-onboarding

# The guard
bunx playwright test --config playwright.qa.config.ts --project control

# One session. The last argument is the budget cap in USD (default 2).
ANTHROPIC_API_KEY=… scripts/qa/explore.sh run c4-skills-projects qa-out 4
QA_MCP_VIEWPORT=390x844 ANTHROPIC_API_KEY=… scripts/qa/explore.sh run c8-phone qa-out 4
```

- **c3 and c5** use real providers: start the stack with `QA_REAL_PROVIDERS=true` and `ANTHROPIC_API_KEY`,
  `TINFOIL_API_KEY`, `TINFOIL_ENCLAVE_URL`, `EXA_API_KEY` in its environment.
- **c7** needs Postgres and PowerSync. Start them as `nightly.yml` does, run `bunx drizzle-kit migrate` in
  `backend/`, start the stack with `DATABASE_URL` and `POWERSYNC_URL` set, and run the session with
  `QA_MCP_CONFIG=qa/mcp-two-devices.json`.

Then the rest of the pipeline:

```sh
# Replay: no keys in this shell, and the stack running with the fake AI
bun scripts/qa/verify.ts replay --out qa-out
ANTHROPIC_API_KEY=… bun scripts/qa/verify.ts judge --out qa-out
bun scripts/qa/file-findings.ts --out qa-out       # dry run: prints what it would file
bun scripts/qa/fix.ts route --out qa-out
bun scripts/qa/report.ts summary --out qa-out      # writes qa-out/report.md
```

`file-findings.ts scorecard` needs a Linear key, so it cannot run offline.

**Canary leg:** build the canary frontend from a patched copy, so your checkout stays clean:

```sh
rm -rf /tmp/qa-canary && mkdir /tmp/qa-canary && git archive HEAD | tar -x -C /tmp/qa-canary
ln -s "$PWD/node_modules" /tmp/qa-canary/node_modules
(cd /tmp/qa-canary && git apply qa/canaries/*.patch)
/tmp/qa-canary/scripts/qa/stack.sh build "$PWD/qa-dist-canary"
```

Serve `qa-dist-canary`, run c8 into `qa-out-canary` and replay it there. Then serve `qa-dist`,
`cp -R qa-out-canary/. qa-out-canary-baseline`, replay that dir, judge `qa-out-canary`, and run
`bun scripts/qa/report.ts canary --out qa-out-canary --baseline qa-out-canary-baseline`.

**Fix agent:** run it in a separate checkout (it edits the working tree), with `scripts/qa/stack.sh serve dev`
from that checkout and the flags of the `fix` job. Collect the patch like the workflow does, then
`bun scripts/qa/fix.ts publish --out qa-out --fp <fp>` without `--live` shows the commit and the PR it would open.

Every out dir must sit directly under the repo root: the specs import `../../../e2e/helpers`.

## Enable it

`workflow_dispatch` only works once the workflow file is on the default branch
([GitHub docs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/manually-running-a-workflow):
"your workflow must be in the default branch"). So:

1. Merge to `main` with `QA_AGENT_ENABLED` unset. Every job is skipped.
2. Create the environment, secrets and variables below.
3. Set `QA_AGENT_ENABLED=true`, leave `QA_LINEAR_ENABLED` and `QA_AUTOFIX_ENABLED` unset. From now on the
   Monday schedule runs too, still as a dry run.
4. Run the workflow by hand from `main` with `dry_run` on (the default), first with one charter
   (`charters: c4-skills-projects`), then with all of them. Read the job summary.
5. Set `QA_LINEAR_ENABLED=true` to file for real. The schedule then files live; a dispatch files live only with
   `dry_run` off. A dispatch from another branch is always a dry run.
6. Later, and only after triage shows the findings are worth it: `QA_AUTOFIX_ENABLED=true`.

### Repository variables

The `build` job has no environment, so these must be repository variables.

| Variable             | Effect                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `QA_AGENT_ENABLED`   | `true` runs the workflow at all (kill switch)                                                           |
| `QA_LINEAR_ENABLED`  | `true` lets `file` and `publish` write to Linear and GitHub                                             |
| `QA_AUTOFIX_ENABLED` | `true` routes confirmed tickets to the fix agent (schedule, or dispatch with `autofix`), only on `main` |
| `CI_ALERTS_ENABLED`  | existing: `notify-on-failure` does nothing until it is `true`                                           |

### Environment `qa-agent`

Used by `explore`, `judge`, `file`, `fix`, `publish` and `report`. No required reviewers (the schedule would hang).
Limit its deployment branches to `main`.

| Secret                                         | Used by                  | What it is                                                                                        |
| ---------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `QA_ANTHROPIC_API_KEY`                         | explore, judge, fix      | a key from a dedicated Anthropic workspace with a monthly spend limit                             |
| `QA_PROVIDER_ANTHROPIC_API_KEY`                | backend of c3, c5        | the app's own Anthropic key for the real-provider charters, QA-only, low limit                    |
| `QA_TINFOIL_API_KEY`, `QA_TINFOIL_ENCLAVE_URL` | backend of c3, c5        | QA-only Tinfoil access for the GLM models                                                         |
| `QA_EXA_API_KEY`                               | backend of c3, c5        | QA-only Exa key for search and link previews                                                      |
| `QA_LINEAR_API_KEY`                            | file, publish, scorecard | Linear key for team Thunderbolt: read issues and labels, create issues and comments, upload files |
| `QA_APP_CLIENT_ID`, `QA_APP_PRIVATE_KEY`       | publish                  | the GitHub App below                                                                              |
| `QA_HEARTBEAT_URL`                             | report                   | optional BetterStack heartbeat, sent after a scheduled run on `main` that worked                  |

These names differ from nightly's on purpose: if an environment secret were missing, a same-named repository
secret would be used without warning. `notify` uses the existing repository secrets `RESEND_API_KEY` and
`LINEAR_API_KEY`, like `nightly.yml`.

### Linear labels

Team Thunderbolt needs these labels, or the filer stops and lists the missing ones:

- `qa-agent`, `Bug`, `security` (filing)
- `human required` (tickets the fix agent must not touch)
- `qa:valid`, `qa:not-a-bug`, `qa:duplicate`, `qa:env-artifact` (triage; the scorecard reads them to compute
  precision, and filing falls back to a dry run while precision stays under 50% over 8+ triaged tickets)

### GitHub App (auto-fix only)

A GitHub App installed on this repository with **Contents: read and write** and **Pull requests: read and
write**. `publish` pushes `qa-fix/<fp>` and opens a draft PR with it. PRs opened with the default `GITHUB_TOKEN`
would not start CI until someone approves the run. Enable "Automatically delete head branches": `route` skips a
fingerprint while its `qa-fix/<fp>` branch exists.

## Budget calibration

Each step type has its own caps, in one place each: the `env` block at the top of `qa-weekly.yml` for explore
and fix (budget, turns, timeout), and `max_tokens` in `verify.ts` for the judge. The first values are generous on
purpose: explore $10 / 400 turns / 60 min, fix $20 / 200 turns / 60 min.

**Rule:** per step type, cap = the highest value observed (the 95th percentile once there are 20 samples) + 50%,
for cost, turns and duration. The report's "Calibration hint" table computes it from the run's own sessions.
Recalibrate after the first two scheduled runs and whenever a charter changes. The Anthropic workspace's monthly
limit stays the hard ceiling.

Measured locally on 2026-09-30 (Sonnet 5.5 explorer, Opus 5.5 judge and fix agent, CLI 2.1.285):

| Step                                                         | Sessions | Cost               | Turns   | Duration    | Stop                  |
| ------------------------------------------------------------ | -------- | ------------------ | ------- | ----------- | --------------------- |
| explore, fake AI (c1, c2, c4, c6, c8)                        | 12       | $0.44–1.22         | 91–227  | 2.6–6.2 min | all finished          |
| explore, real providers (c3, c5)                             | 4        | $0.48–1.11         | 81–134  | 3.3–7.4 min | all finished          |
| explore, canary leg (c8)                                     | 2        | $0.94–1.03         | 154–162 | 4.6–4.8 min | all finished          |
| judge (Opus 5.5, one call per finding, 4–5 findings per run) | 4 runs   | $0.05–0.08 per run | –       | –           | –                     |
| fix agent (one overflow bug)                                 | 1        | $0.26              | 21      | 3.1 min     | finished, spec passes |

A full set of 8 charters plus the canary leg cost about $7 in explore sessions, 30 min of session time in total.
Cache reads are most of every explore session's cost. c3 and c5 also spend on the app's own providers (38 real
Opus 5 calls over two runs); the backend logs no token counts for them. c7 has not been measured yet.

With these numbers the rule gives explore ≈ $1.8 / 341 turns / 11 min and fix ≈ $0.4 / 32 turns / 5 min. That
is one local sample per charter and a single fix, so keep the initial caps until two scheduled runs have reported.

## Cut sessions

A session stopped by its budget, its turn cap or the step timeout keeps every finding it wrote, and they are
verified like any other. The report lists cut sessions first, under "⚠️ N INCOMPLETE session(s)", marks their
stop as **BUDGET CAP**, **TURN CAP**, **TIMEOUT** or **ERROR**, and shows "no summary (session cut)" under
Coverage. A timed-out step leaves no execution file, so its cost shows as $0.00. Look at the Anthropic
workspace's usage for the real figure. A leg that crashed, or whose explore job failed the checksum check, shows
as **ERROR** with no findings. When every explore session of the weekly charters, or of the canary leg, ends in
an error or a timeout, `report.ts summary` exits 1 and the report job fails, so `notify-on-failure` fires.

## Promote a confirmed spec to `e2e/`

The fix agent's draft PR already does this. By hand:

1. Take `qa-out/<charter>/repro/<n>.spec.ts` from the run's `qa-replay-weekly` artifact.
2. Save it as `e2e/consumer-qa-<fp>.spec.ts` (`e2e/sync-qa-<fp>.spec.ts` for c7).
3. Change `'../../../e2e/helpers'` to `'./helpers'`, and `@playwright/test` to `./test` when it imports only
   `test`, `expect`, `Page`, `Request` or `Route`.
4. `bun run e2e:check-collected`, then check that the spec fails before the fix and passes after it.

A c1 spec runs against the onboarding build on port 1425, which `playwright.config.ts` does not start. It needs
its own project before it can live in `e2e/`.

## Owners

The Monitoring / E2E Tests project lead owns the charters, `noise.txt`, `known-issues.md` and the canaries, and
turns confirmed specs into permanent tests. Add a `known-issues.md` entry for every bug that is tracked or
accepted, and remove it once it is fixed. Whoever triages on Monday puts one `qa:` label on every `qa-agent` ticket.

Charters carry no step budget on purpose. With "about 200 tool calls" in c4, the explorer stopped near that
number and skipped items "out of budget" with 70% of its money left.

## Known limits

Never run on GitHub (only locally, or read in the action's code):

- the workflow as a whole, including the matrix, the artifacts between jobs and the job conditions;
- `claude-code-action` forwarding `--setting-sources`, `--permission-mode`, `--tools` and the MCP config;
- conditional service containers with an empty image, YAML anchors, and brace patterns in `download-artifact`;
- installing the MCP's Chromium with `npx --package @playwright/mcp@0.0.83 playwright install chromium`;
- the GitHub App token, the bot identity lookup, the push and `gh pr create`;
- every Linear call: label and state lookups, dedupe, `fileUpload`, ticket creation, the scorecard query;
- the heartbeat and `notify-on-failure` for this workflow;
- the explore job's inline stop, checksum check and result upload, and the fix job's spec replay (each was run
  locally as a script under `bash -eo pipefail`, not inside Actions);
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` passed through the action (probed with the CLI only);
- c7 (two devices, Postgres and PowerSync) and the weekly replay on Postgres + PowerSync, which have not run
  locally either (Docker was down during the local run).

Also:

- The explorer still stops early by itself and lists some charter items as skipped, "not tried". Coverage in the
  report shows them; the charter owner decides whether a charter is too long.
- The judge is a model: a borderline finding can be kept in one run and dropped in the next (the Custom provider
  placeholder request in c3 was).
- Repro specs are model-written. A spec that fails before its assertion is dropped by the judge even when the bug
  is real, which is how the skill-delete canary was missed locally (recall 2/3).
- A scheduled run acts as the user who last edited the cron line. `claude-code-action` refuses bot actors, so
  that must be a person.
- The fix agent can still run any code (its `bun run test` runs test files it writes), but without the Anthropic
  key in that code's environment. The boundary is that the fix job holds no write token and a person reviews the
  draft PR.
- On CLI 2.1.285, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forces the permission mode from `dontAsk` to `default`. With
  explicit allow lists both deny every unlisted command and allow read-only ones (probed).
- c3 and c5 specs replay on the fake AI, so a bug that only shows with a real model is filed only if its spec
  also fails with the fake one.
