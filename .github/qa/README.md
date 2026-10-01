# Weekly exploratory QA

Once a week an AI agent uses the web app the way a person would. It tests one area per session: the area's list
of **functions** that must work (`functions.json`), with a **charter** of steps to follow (`charters/`) or a
**mission** that leaves the steps to the agent (`missions/`). It records every attempt as it goes. When something
breaks, it writes a finding and a Playwright spec that fails because of the bug. Plain code then checks the attempts
against what the browser really returned, replays each spec, asks a second model whether the finding is real, and
files the confirmed ones in Linear. It can also hand a few of them to a fix agent that opens draft PRs. The workflow
never merges, approves or marks anything ready.

The workflow is `.github/workflows/qa-weekly.yml`. It runs on Mondays at 07:00 UTC, and by hand with
`workflow_dispatch`. It does nothing until the `QA_AGENT_ENABLED` variable is `true`.

## Trust zones

The explorer reads untrusted pages, so everything it writes is untrusted too. Each job holds only the secret it needs.

| Zone                  | Jobs                         | Holds                                                                                        | Never holds                                                                                   |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A: explore and verify | `explore`, `replay`, `judge` | the QA Anthropic key (explore, judge); QA provider keys in c3/c5's backend (another OS user) | Linear key, any write token. The replay step holds **no secret**: it runs model-written specs |
| B: file               | `file`                       | the QA Linear key                                                                            | an LLM, a browser                                                                             |
| C: fix                | `fix`, then `publish`        | `fix`: the QA Anthropic key, read-only token. `publish`: GitHub App token + Linear key       | `publish` runs no LLM and checks the patch in code                                            |

Only the `build` job saves caches, because it runs before any untrusted code. The judge runs in a fresh job,
because the replayed specs may have changed files in the replay job's checkout.

The browser tools can write files anywhere in the explore job's checkout, so no repo code runs there after the
explorer. The stack is killed inline from pid files outside the checkout (`$RUNNER_TEMP/qa-stack.pid*`). A
`sha256sum` check of every tracked file must pass, or the job fails and uploads nothing. Only then does `jq` cut the
public transcript out of the execution file with `transcript.jq`, a filter (jq runs no commands and opens no files)
that the checksum check covers. The session output must not hold any key the job has (an exact-value check, inline),
or nothing is uploaded. The session metrics and the coverage check run later, in the report job. The explore and fix agent steps set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so
no command they start inherits the Anthropic key in its environment. The fix job also installs bubblewrap, so those
commands run in a sandbox and cannot read the key from the CLI's own process either.

Never add `--allow-unrestricted-file-access` to `mcp.json` or set `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS`.
The MCP blocks `file:` URLs by default, and that block keeps local files out of the explorer's reach.

### Real-AI legs

c3 and c5 explore with the real providers, and their findings replay with them too, so the provider keys share a
job with model-written specs. Two things keep them apart:

- **A separate OS user for the backend.** With `QA_BACKEND_USER=qa-backend`, `stack.sh start` creates that user,
  writes the four keys to `/home/qa-backend/keys.env` (mode 0400, owned by that user) and drops them from its own
  environment before any server starts. The backend runs through `sudo -u qa-backend` and reads the file with
  `bun --env-file`. No process of the job's user holds a key, in its environment, its command line or a log.
- **No root after the stack is up.** `stack.sh lock` removes the docker socket (the docker group is root in all but
  name), adds a last sudoers rule that denies the job's user every command, and fails unless `sudo` really fails and
  Yama's `ptrace_scope` is 1 or more. Yama 1 keeps a process from reading the memory of its ancestors, such as the
  runner's, which holds every secret the job references.

A spec that gets past the lint then runs as a user that cannot read the key file, the backend's `/proc` entries or
the runner's memory. The `real` replay leg is the only replay leg with an environment (`qa-agent`), for the keys its
start step hands over. Its replay step holds none.

Residual risk: the backend runs code from the job user's checkout, which a spec can rewrite (Playwright can save a
download anywhere). A module the backend first imported after the specs started would run as `qa-backend`. Today
it imports everything at start. If that changes, run it from a copy the job's user cannot write.

## Pipeline and files

1. **build**: three frontend builds (normal, onboarding on for c1, canaries planted), then the **guard**: a fresh
   stack must pass `control/stack.spec.ts`, or the run stops and `notify-on-failure` fires.
2. **explore**: one job per charter with `claude-code-action` and the Playwright MCP (`mcp.json`,
   `mcp-two-devices.json` for c7). The prompt is `prompt.md`, then the charter or the mission (see below), then the
   area's function list. The explorer writes `qa-out/<charter>/attempts/<n>.json` after each attempt, and
   `findings/<n>.json` and `repro/<n>.spec.ts` as soon as it finds each bug, so a cut session keeps what it did.
   The job uploads the counters of the session's result message and `transcript.json`: the browser tool calls and
   their results (each cut to 20,000 characters), without the prompt or any model text. The report job turns the
   counters into `session.json` with `scripts/report.ts session`. Every finding names an oracle from `prompt.md`.
   With the real AI that includes `ai-reported-failure`: the app's AI says a tool, search, connection, file or
   integration failed, which the console and the network often do not show (an AI that could not read the user's
   calendar).
3. **replay** (`scripts/verify.ts replay`): schema check, oracle check (`noise.txt` turns console noise into
   observations), spec lint, then up to 20 specs per leg run 3 times each (`playwright.config.ts` here) next to the
   control spec; the rest are deferred.
   3 of 3 failures = confirmed, 1 or 2 = flaky (report only), 0 = dropped. c7's findings (artifact prefix
   `qa-sync`) replay in their own leg on Postgres + PowerSync. The real-AI charters' findings (`realAiCharters` in
   `scripts/findings.ts`, today c3 and c5; artifact prefix `qa-real`) replay in their own leg against the real
   providers, where replies vary: 2 or 3 failures of 3 = confirmed, 1 = flaky, 0 = dropped. The rest replay on
   pglite with the fake AI. The judge takes all three.
4. **judge** (`verify.ts judge`): one fresh Opus call per confirmed finding with `judge.md` and `known-issues.md`,
   at most 15 per leg and only while their worst-case cost stays under $2; the rest are deferred, never filed. The
   default answer is drop. Writes `verified.json`.
5. **file** (`scripts/file-findings.ts`): fingerprint, dedupe against Linear, severity from a table in code,
   at most 8 new tickets plus one roll-up (security findings: 3 more plus their own roll-up, without the run link),
   secret refusal, video upload. Dry run unless `--live`.
6. **fix** (off by default): `scripts/fix.ts route` picks at most 3 tickets in fixable areas, never a real-AI
   finding: its check below runs on the fake AI, so it could not show the fix works. Those go to a person. The fix agent
   (`fix.md`) writes a patch without git. A step without secrets then replays the original spec 3 times on the
   patched code. A session that did not finish, or a spec that still fails, becomes a diagnosis, so the ticket goes
   to a person. `fix.ts publish` rejects paths it does not allow, edited specs and empty patches, then opens a draft PR on
   `qa-fix/<fp>`, or labels the ticket `human required`. `preview-deploy.yml` deploys no preview for `qa-fix/*`
   PRs; a maintainer can still dispatch one.
7. **report** (`report.ts summary`): the job summary with sessions, evidence-supported coverage, gate yield, every
   flaky finding with its evidence, the deferred and drop lists, what was filed, canary recall and the calibration
   table.

The **canary leg** runs c8 against a build with the planted bugs in `canaries/` (`canaries.json` describes them).
Its findings replay on the canary build, then again on the normal build. A canary counts as found only when its
finding fails on the canary build, passes on the normal build and mentions that canary's keywords.
Canary findings are never filed.

Run-time output goes to `qa-out*/` (gitignored). `fixtures/` holds the PDF and image the charters upload; `prompt.md`
tells the explorer what they contain, and forbids it to tell the app's AI.

## Functions, charters and missions

`functions.json` holds one list per area (c1 to c8): what must work, as an id and an observable outcome, plus
`reload: true` where the outcome must survive a reload. A function that spans two areas has one owner: how project
instructions change a real reply is c5's `project-instructions-reply`. Integrations (Google, Microsoft) are in no
list: nothing covers them.

Two styles share that list, the prompt, the oracles and the evidence rules:

- **scripted** (`charters/`, the default): steps and edge cases to follow, each naming the function ids it covers.
- **mission** (`missions/`): only the target, the risks, the start state and what is out of bounds. The explorer
  picks its own tests, with the toolbox in `prompt.md`.

The `arm` input of a dispatch picks the style (the schedule always runs `scripted`); locally it is `QA_ARM`.

**Coverage** (`report.ts summary`) counts a function only when one of its `passed` or `failed` attempts quotes text
that a browser tool returned, inside that attempt's window (since the previous record), after a browser action in
that window, and, for a passed `reload` function, after a navigation that follows a change. The code a tool echoes
back (what the explorer typed) never counts. Every function in the list is in the denominator, so a missing one is
"unattempted". A session without a transcript (a timeout, a broken save) covers nothing. The check proves the
quote was really seen at the right moment, not that it shows the outcome, and that some reload followed some change
in the attempt, not that it followed the change under test: sample covered functions by hand.

## Run it locally

Everything runs from the repo root. The stack uses fixed ports (1424, 1425, 8005, 9878, 9879), so stop any
`bun run e2e` first. Use a production build: the Vite dev server reloads pages while Playwright writes traces.

```sh
# Builds (about 3 s each)
.github/qa/scripts/stack.sh build qa-dist
.github/qa/scripts/stack.sh build qa-dist-onboarding onboarding   # only for c1

# The stack: fake AI, pglite, the normal build on 1424 and the onboarding build on 1425. Leave it running.
.github/qa/scripts/stack.sh serve qa-dist qa-dist-onboarding

# The guard
bunx playwright test --config .github/qa/playwright.config.ts --project control

# One session. The last argument is the budget cap in USD (default 2). QA_ARM=mission runs the mission instead.
ANTHROPIC_API_KEY=… .github/qa/scripts/explore.sh run c4-skills-projects qa-out 4
QA_MCP_VIEWPORT=390x844 ANTHROPIC_API_KEY=… .github/qa/scripts/explore.sh run c8-phone qa-out 4
```

- **c3 and c5** use real providers: start the stack with `QA_REAL_PROVIDERS=true` and `ANTHROPIC_API_KEY`,
  `TINFOIL_API_KEY`, `TINFOIL_ENCLAVE_URL`, `EXA_API_KEY` in its environment. Replay their findings against that
  same stack, from their own out dir. Locally the backend runs as you: `QA_BACKEND_USER` and `stack.sh lock` are
  for CI's throwaway Linux runners (`lock` would take your sudo away for good).
- **c7** needs Postgres and PowerSync. Start them as `nightly.yml` does, run `bunx drizzle-kit migrate` in
  `backend/`, start the stack with `DATABASE_URL` and `POWERSYNC_URL` set, and run the session with
  `QA_MCP_CONFIG=.github/qa/mcp-two-devices.json`.

Then the rest of the pipeline:

```sh
# Replay: no keys in this shell, and the stack running with the fake AI (real providers for c3 and c5)
bun .github/qa/scripts/verify.ts replay --out qa-out
ANTHROPIC_API_KEY=… bun .github/qa/scripts/verify.ts judge --out qa-out
bun .github/qa/scripts/file-findings.ts --out qa-out    # dry run: one line per finding, text in filed.json
bun .github/qa/scripts/fix.ts route --out qa-out
bun .github/qa/scripts/report.ts summary --out qa-out   # writes qa-out/report.md
```

A filer dry run logs one line per finding (fingerprint, severity, action), because the Actions log is public. The
would-be ticket text is `preview` in `filed.json`, except for security findings, which get none.
`file-findings.ts scorecard` needs a Linear key, so it cannot run offline.

**Canary leg:** build the canary frontend from a patched copy, so your checkout stays clean:

```sh
rm -rf /tmp/qa-canary && mkdir /tmp/qa-canary && git archive HEAD | tar -x -C /tmp/qa-canary
ln -s "$PWD/node_modules" /tmp/qa-canary/node_modules
(cd /tmp/qa-canary && git apply .github/qa/canaries/*.patch)
/tmp/qa-canary/.github/qa/scripts/stack.sh build "$PWD/qa-dist-canary"
```

Serve `qa-dist-canary`, run c8 into `qa-out-canary` and replay it there. Then serve `qa-dist`,
`cp -R qa-out-canary/. qa-out-canary-baseline`, replay that dir, judge `qa-out-canary`, and run
`bun .github/qa/scripts/report.ts canary --out qa-out-canary --baseline qa-out-canary-baseline`.

**Fix agent:** run it in a separate checkout (it edits the working tree), with
`.github/qa/scripts/stack.sh serve dev` from that checkout and the flags of the `fix` job. Collect the patch like
the workflow does, then `bun .github/qa/scripts/fix.ts publish --out qa-out --fp <fp>` without `--live` shows the
commit and the PR it would open.

Every out dir must sit directly under the repo root: the specs import `../../../e2e/helpers`.

The scripts' tests and type check: `bun run test:qa` and `bunx tsc -p .github/qa` (the `qa` job in `ci.yml` runs
both when a QA file changes).

## Enable it

`workflow_dispatch` only works once the workflow file is on the default branch
([GitHub docs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/manually-running-a-workflow):
"your workflow must be in the default branch"). So:

1. Merge to `main` with `QA_AGENT_ENABLED` unset. Every job is skipped.
2. Create the environment, secrets and variables below.
3. Set `QA_AGENT_ENABLED=true`, leave `QA_LINEAR_ENABLED` and `QA_AUTOFIX_ENABLED` unset. From now on the
   Monday schedule runs too, still as a dry run.
4. Run the workflow by hand from `main` with `dry_run` on (the default), first with one charter
   (`charters: c4-skills-projects`; separate several ids with commas or spaces), then with all of them. Read the
   job summary.
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

Used by `explore`, the real-AI `replay` leg, `judge`, `file`, `fix`, `publish` and `report`. No required reviewers
(the schedule would hang). Limit its deployment branches to `main`.

| Secret                                         | Used by                  | What it is                                                                                        |
| ---------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- |
| `QA_ANTHROPIC_API_KEY`                         | explore, judge, fix      | a key from a dedicated Anthropic workspace with a monthly spend limit                             |
| `QA_PROVIDER_ANTHROPIC_API_KEY`                | c3/c5 backend and replay | the app's own Anthropic key for the real-provider charters, QA-only, low limit                    |
| `QA_TINFOIL_API_KEY`, `QA_TINFOIL_ENCLAVE_URL` | c3/c5 backend and replay | QA-only Tinfoil access for the GLM models                                                         |
| `QA_EXA_API_KEY`                               | c3/c5 backend and replay | QA-only Exa key for search and link previews                                                      |
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
  precision, and filing falls back to a dry run while precision stays under 70% over 8+ triaged tickets that are
  not duplicates)

### GitHub App (auto-fix only)

A GitHub App installed on this repository with **Contents: read and write** and **Pull requests: read and
write**. `publish` pushes `qa-fix/<fp>` and opens a draft PR with it. PRs opened with the default `GITHUB_TOKEN`
would not start CI until someone approves the run. Enable "Automatically delete head branches": `route` skips a
fingerprint while its `qa-fix/<fp>` branch exists.

Residual risk: test code that the fix agent writes runs in the same job as the QA Anthropic key. The Anthropic
workspace's spend limit bounds what a leaked key can cost, and auto-fix stays off unless `QA_AUTOFIX_ENABLED` is
`true`. Before its upload, the fix job fails and uploads nothing if `qa-out/fix/` holds the key or a token prefix.

## Budget calibration

Each step type has its own caps, in one place each: the `env` block at the top of `qa-weekly.yml` for explore
and fix (budget, turns, timeout), and the constants at the top of `verify.ts` for the judge's `max_tokens` and the
aggregate caps. The first values are generous on purpose: explore $10 / 400 turns / 60 min, fix $20 / 200 turns /
60 min.

The aggregate caps bound a whole leg, whatever the sessions found: at most 20 findings replayed per replay leg (four
legs at most) and 15 judged per judge leg (weekly, canary), and a judge leg spends at most $2. The judge admits a
call only if its worst case fits: the prompt's UTF-8 bytes (a token covers at least one byte) plus `max_tokens` of
output, at Opus prices. Findings over a cap are listed as deferred in the report and are never filed. The app's own
provider calls in c3 and c5 are **not measured**: the backend logs no token counts for them, so watch the QA provider
keys' dashboards; the report says so whenever a real-AI charter ran.

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
Coverage. A timed-out step leaves no execution file, so its cost shows as $0.00 and its coverage as **no
transcript**: its attempt records stay unchecked. Look at the Anthropic
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

A c1 spec runs against the onboarding build on port 1425, which the root `playwright.config.ts` does not start. It
needs its own project before it can live in `e2e/`.

## Owners

The Monitoring / E2E Tests project lead owns `functions.json`, the charters and missions, `noise.txt`,
`known-issues.md` and the canaries, and
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
- the explore job's transcript cut and secret check, and the `arm` input (the same `transcript.jq` and an exact-value
  `grep` ran locally on real sessions' output);
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` passed through the action (probed with the CLI only);
- the bubblewrap sandbox in the fix job, including whether the agent's own spec run can still reach the local
  stack from inside it (the separate spec replay step runs outside the sandbox), and the fix output's secret scan
  (run locally as a script);
- c7 (two devices, Postgres and PowerSync) and its sync replay leg on Postgres + PowerSync, which have not run
  locally either (Docker was down during the local run);
- the real-AI isolation on a hosted runner: `useradd`, the backend under `sudo -u qa-backend` reaching bun and the
  checkout in the runner's home, the sudoers rule, the removed docker socket and the Yama check. The same
  `stack.sh` ran in an Ubuntu 24.04 container on Docker Desktop with stub servers, as a `runner` user with
  passwordless sudo and a 0750 home: the backend got the keys and the job's user could not read them, but that
  kernel has no Yama, so only the check's fail-closed branch ran;
- the job-level `environment` expression that is empty for every replay leg but the real one, and the judge's
  merge of the sync and real candidates from per-artifact directories (run locally as a script).

Also:

- The explorer can still stop early by itself. Coverage in the report shows every function it did not reach as
  "unattempted"; the charter owner decides whether an area's list is too long.
- The coverage check trusts the transcript, which the explorer cannot edit, but not what a quote means: an explorer
  can quote a real line that does not show the outcome. Sample covered functions by hand.
- The judge is a model: a borderline finding can be kept in one run and dropped in the next (the Custom provider
  placeholder request in c3 was).
- Repro specs are model-written. A spec that fails before its assertion is dropped by the judge even when the bug
  is real, which is how the skill-delete canary was missed locally (recall 2/3).
- A security finding's ticket carries no run link, but its finding JSON and repro spec still sit in the explore
  and replay artifacts for their 7-day retention. This repo is public, so any signed-in GitHub user can download
  them.
- A scheduled run acts as the user who last edited the cron line. `claude-code-action` refuses bot actors, so
  that must be a person.
- The fix agent can still run any code (its `bun run test` runs test files it writes), but without the Anthropic
  key in that code's environment. The boundary is that the fix job holds no write token and a person reviews the
  draft PR.
- On CLI 2.1.285, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forces the permission mode from `dontAsk` to `default`. With
  explicit allow lists both deny every unlisted command and allow read-only ones (probed).
- A real model can fail twice in three replays by chance, and pass twice although the bug is real. The judge drops
  provider outages and expected limitations, and a real-AI finding never goes to the fix agent.
- Integrations (Google, Microsoft) are explicitly out of coverage. They need a function list and a test account per
  provider, connected before the session, whose tokens the backend would hold like the provider keys.
