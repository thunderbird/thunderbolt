# Weekly exploratory QA

Once a week an AI agent uses the web app the way a person would. It tests one area per session: the area's list
of **functions** that must work (`functions.json`), with a **charter** of steps to follow (`charters/`). A **free
session** also plays one person's goal, with no steps, on every platform. When something breaks, the agent writes a
finding and a Playwright spec that fails because of the bug. Plain code then checks its attempts against what the
browser really returned, replays each spec, asks a second model whether the finding is real, and files the
confirmed ones in Linear. A fix agent can open draft PRs for a few. The workflow never merges, approves or marks
anything ready.

The workflow is `.github/workflows/qa-weekly.yml`. It runs on Mondays at 07:00 UTC, and by hand with
`workflow_dispatch`. It does nothing until the `QA_AGENT_ENABLED` variable is `true`.

## Trust zones

The explorer reads untrusted pages, so everything it writes is untrusted too. Each job holds only the secret it needs.

| Zone                  | Jobs                         | Holds                                                                                        | Never holds                                                                                   |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| A: explore and verify | `explore`, `replay`, `judge` | the QA Anthropic key (explore, judge); QA provider keys in real-AI backends (other OS users) | Linear key, any write token. The replay step holds **no secret**: it runs model-written specs |
| B: file               | `file`                       | the QA Linear key                                                                            | an LLM, a browser                                                                             |
| C: fix                | `fix`, then `publish`        | `fix`: the QA Anthropic key, read-only token. `publish`: GitHub App token + Linear key       | `publish` runs no LLM and checks the patch in code                                            |

Only the `build` job saves caches, because it runs before any untrusted code. The judge runs in a fresh job,
because the replayed specs may have changed files in the replay job's checkout.

The browser tools can write files anywhere in the explore job's checkout, so no repo code runs there after the
explorer: the stack is stopped inline, a checksum of every tracked file must still match, and the session output
must hold no key the job has, or nothing is uploaded. Metrics and coverage are computed later, in the report job.
The explore and fix agent steps set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so no command they start inherits the
Anthropic key, and both jobs install bubblewrap, which the scrubbed CLI needs to run those commands in a sandbox.

Never add `--allow-unrestricted-file-access` to `mcp.json` or set `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS`.
The MCP blocks `file:` URLs by default, and that block keeps local files out of the explorer's reach.

### Real-AI legs

c3, c4, c5 and the free sessions explore with the real providers, and their findings replay with them too, so the
provider keys share a job with model-written specs. Two things keep them apart:

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

Residual risk: the lint refuses Playwright's file writes by name. That is a denylist, so a write API added in a
Playwright upgrade would get through and could rewrite the checkout that later replay steps and the backend run
code from. The fallback is a checkout the job's user cannot write during replay.

## Pipeline and files

1. **build**: the normal, onboarding (c1) and canary builds, then the guard: a fresh stack must pass
   `control/stack.spec.ts`, or the run stops and `notify-on-failure` fires.
2. **explore**: one leg per charter and one per free-session platform (`free-<case>-<platform>`), with
   `claude-code-action`, the Playwright MCP (`mcp.json`, plus `mcp-two-devices.json` for c7's second browser) and the
   prompt `explore.sh prompt` builds. Attempts, findings and repro specs are written as they happen, so a cut session
   keeps its work.
3. **replay** (`verify.ts replay`): schema, oracle (`noise.txt`) and lint gates, then each spec 3 times. 3 of 3
   failures confirm a finding, 2 of 3 for the real-AI charters (`realAiCharters` in `findings.ts`); 1 or 2 are flaky
   (report only), 0 is dropped. c7 replays on Postgres + PowerSync, the real-AI charters against the real providers,
   the rest on pglite with the fake AI.
4. **judge** (`verify.ts judge`): one Opus call per confirmed finding with `judge.md` and `known-issues.md`. The
   default answer is drop. Writes `verified.json`.
5. **file** (`file-findings.ts`): fingerprint dedupe, severity table, ticket caps and roll-ups, secret refusal.
   Dry run unless `--live`.
6. **fix** (off by default, `fix.ts` and `fix.md`): at most 3 fake-AI tickets in fixable areas. The original spec
   must pass 3 times on the patch before `publish` opens a draft PR on `qa-fix/<fp>`; otherwise the ticket gets
   `human required`. `preview-deploy.yml` deploys no preview for `qa-fix/*` PRs.
7. **report** (`report.ts summary`): the job summary.

Output goes to `qa-out*/` (gitignored). `fixtures/` holds the files the charters upload.

## Canaries

A canary is a bug we know is there, used to check that the explorer still finds bugs. Each week the build job runs
`scripts/canaries.ts`. It takes the `fix:` commits merged to `main` in the last 8 weeks, newest first, and keeps
at most two that:

- change app code under `src/` (tests, test helpers, docs and translations are left alone);
- touch no sensitive path: the same list that keeps the fix agent away (`isSensitive` in `fix.ts`);
- map to a charter in the script's one table (c2 to c6 and c8), one canary per charter, both on the same kind of AI;
- change no runtime code outside `src/` (`shared/`, `backend/`, `public/`, `index.html`, the Vite config): the reversal
  covers `src/` only, and the canary backend runs from the unpatched checkout;
- can be reverted on the current tree with `git apply -R --check`.

The canary build reverts those fixes. It runs before the legs are planned: if it fails, the run warns, the tree is
restored and the canary leg is skipped as if nothing qualified, so a bad canary never costs the weekly run. Each one
gets an explore session with its charter on that build, so at most 2 sessions a week. A canary counts as found only when a finding fails on the canary build, passes on the normal
build and names a word from the fix's title. The report lists each fix (title, sha, charter, found or missed).
Canary findings are never filed.

Why real fixes: they are bugs users really hit, nobody tuned the prompts for them, and they rotate by themselves as
new fixes land. When nothing qualifies, the leg is skipped and the report says so; the build log has one line per
skipped fix with the reason. Most often a later change touched the same lines; that clears up with the next fixes.

## Functions, coverage and the free session

`functions.json` lists per area (c1 to c8) what must work: an id, an observable outcome, and `reload: true` when
the outcome must survive a reload. A function that spans two areas has one owner. Each charter in `charters/` names
the function ids its steps cover. Integrations are in no list; Google is covered through the fake Google below.

**Coverage** counts a function only when a `passed` or `failed` attempt quotes text a browser tool returned in that
attempt's window, after a browser action, and, for a passed `reload` function, after a navigation that follows a
change.
Text the explorer typed never counts, and a session without a transcript covers nothing. The check proves the quote
was seen at the right moment, not that it shows the outcome: sample covered functions by hand.

The **free session** plays one case from `journeys.json` (a person, a goal with no steps, and `facts` the explorer
uses to judge the AI's answers) on every platform in `platforms.json`, with the real AI.

- `explore.sh journey` picks the case: weeks since 1970 modulo the number of cases, so every case runs once before
  any repeats. A dispatch's `journey` input forces one; `charters: free` runs only the free session.
- Add a case by appending an object with a new `id` (it shifts the rotation once). `bun run test:qa` checks it.
- A platform is one entry (an `id` without a hyphen, a viewport, an MCP config) and one explore leg. A native
  platform also needs its driver and a new `viewport` value in the finding schema.
- `free-*` legs are real-AI charters: two failures in three confirm, and they never go to the fix agent. One case
  on two platforms costs about $1.3 a week; each platform adds about half of that.

## Run it locally

Everything runs from the repo root. The stack uses fixed ports (1424, 1425, 8005, 9878, 9879, 9880), so stop any
`bun run e2e` first. Use a production build: the Vite dev server reloads pages while Playwright writes traces.

```sh
# Builds (about 3 s each)
.github/qa/scripts/stack.sh build qa-dist
.github/qa/scripts/stack.sh build qa-dist-onboarding onboarding   # only for c1

# The stack: fake AI, pglite, the normal build on 1424 and the onboarding build on 1425. Leave it running.
.github/qa/scripts/stack.sh serve qa-dist qa-dist-onboarding

# The guard
bunx playwright test --config .github/qa/playwright.config.ts --project control

# One session. The last argument is the budget cap in USD (default 2).
ANTHROPIC_API_KEY=… .github/qa/scripts/explore.sh run c2-chat-power-user qa-out 4
QA_MCP_VIEWPORT=390x844 ANTHROPIC_API_KEY=… .github/qa/scripts/explore.sh run c8-phone qa-out 4
```

- **The free session** runs one case on one platform per call, named `free-<case>-<platform>` (`explore.sh journey`
  prints this week's case). It takes its viewport and MCP config from `platforms.json` and needs the real-provider
  stack below: `ANTHROPIC_API_KEY=… .github/qa/scripts/explore.sh run free-trip-planner-phone qa-out 4`.
- **c3, c4, c5 and the free session** use real providers: start the stack with `QA_REAL_PROVIDERS=true` and
  `ANTHROPIC_API_KEY`, `TINFOIL_API_KEY`, `TINFOIL_ENCLAVE_URL`, `EXA_API_KEY` in its environment. Replay their
  findings against that same stack, from their own out dir. Locally the backend runs as you: `QA_BACKEND_USER` and
  `stack.sh lock` are for CI's throwaway Linux runners (`lock` would take your sudo away for good).
- **c7** needs Postgres and PowerSync. Start them as `nightly.yml` does, run `bunx drizzle-kit migrate` in
  `backend/`, start the stack with `DATABASE_URL` and `POWERSYNC_URL` set, and run the session with
  `QA_MCP_CONFIG='.github/qa/mcp.json .github/qa/mcp-two-devices.json'` (the second file adds its second browser).

Then the rest of the pipeline:

```sh
# Replay: no keys in this shell, and the stack running with the fake AI (real providers for c3–c5 and free-*)
bun .github/qa/scripts/verify.ts replay --out qa-out
ANTHROPIC_API_KEY=… bun .github/qa/scripts/verify.ts judge --out qa-out
bun .github/qa/scripts/file-findings.ts --out qa-out    # dry run; LINEAR_API_KEY adds dedupe and scorecard.json
bun .github/qa/scripts/fix.ts route --out qa-out
bun .github/qa/scripts/report.ts summary --out qa-out   # writes qa-out/report.md
```

A filer dry run logs only one line per finding, because the Actions log is public. The would-be ticket text is
`preview` in `filed.json`, except for security findings, which get none.

**Canary leg:** pick the canaries, then build the canary frontend from a reverted copy, so your checkout stays clean:

```sh
git fetch origin main
bun .github/qa/scripts/canaries.ts --out /tmp/qa-canaries.json --patch /tmp/qa-canary.patch
rm -rf /tmp/qa-canary && mkdir /tmp/qa-canary && git archive HEAD | tar -x -C /tmp/qa-canary
ln -s "$PWD/node_modules" /tmp/qa-canary/node_modules
(cd /tmp/qa-canary && git apply --reverse /tmp/qa-canary.patch)
/tmp/qa-canary/.github/qa/scripts/stack.sh build "$PWD/qa-dist-canary"
```

Serve `qa-dist-canary`, run each canary's charter into `qa-out-canary` and replay it there. Then serve `qa-dist`,
`cp -R qa-out-canary/. qa-out-canary-baseline`, replay that dir, judge `qa-out-canary`, and run
`bun .github/qa/scripts/report.ts canary --out qa-out-canary --baseline qa-out-canary-baseline --canaries
/tmp/qa-canaries.json`.

**Fix agent:** run it in a separate checkout (it edits the working tree), with
`.github/qa/scripts/stack.sh serve dev` from that checkout and the flags of the `fix` job. Collect the patch like
the workflow does, then `bun .github/qa/scripts/fix.ts publish --out qa-out --fp <fp>` without `--live` shows the
commit and the PR it would open.

Every out dir must sit directly under the repo root: the specs import `../../../e2e/helpers`.

The scripts' tests and type check: `bun run test:qa` and `bunx tsc -p .github/qa` (the `qa` job in `ci.yml` runs
both when a QA file changes).

## Fake Google

`scripts/fake-google.ts` stands in for Google on `127.0.0.1:9880`: the account chooser, the token endpoint, userinfo,
and exactly the Gmail and Calendar endpoints the app's tools call, with Google's JSON and error bodies. `stack.sh`
always starts it, even with `QA_REAL_PROVIDERS=true`, and points the build (`VITE_GOOGLE_BASE_URL`) and the backend
(`GOOGLE_BASE_URL`, plus a fake client id and secret) at it. The app honours either override only on a loopback host,
so a build with a wrong value still talks to the real Google.
Microsoft has the same loopback-only seam (`VITE_MICROSOFT_BASE_URL`, `MICROSOFT_BASE_URL`) but no fake yet.

Connect it in Settings → Connections → Connect Google, then pick an account. Times are UTC and move with today:
"Thursday" is the next Thursday. On a Thursday, the calendar tool's 7-day window cuts that day short.

| Account (`@gmail.test`) | What it does                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `jonas`                 | Primary calendar plus the work calendar `jonas@northwind.test`; on Thursday only 11:00–12:00 is free in both |
| `camille`               | 8 emails from the last two days, 6 unread                                                                    |
| `expired`               | Tokens say `expires_in: 1`, so every call refreshes first                                                    |
| `revoked`               | Refreshing fails with `invalid_grant`                                                                        |
| `no-calendar-api`       | Calendar answers 403 `accessNotConfigured`; Gmail works                                                      |
| `no-calendar-scope`     | Consent drops the calendar scope; Calendar answers 403 `insufficientPermissions`                             |
| `empty`                 | Empty inbox and calendar                                                                                     |
| `big`                   | 1,200 emails and 80 events in the next 7 days, over the tool's 50                                            |

The four failure accounts get Jonas's calendars and Camille's inbox. Codes and tokens live in the fake's memory, so
restarting the stack disconnects Google.

## Enable it

`workflow_dispatch` only works once the workflow file is on the default branch
([GitHub docs](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/manually-running-a-workflow):
"your workflow must be in the default branch"). So:

1. Merge to `main` with `QA_AGENT_ENABLED` unset. Every job is skipped.
2. Create the environment, secrets and variables below.
3. Set `QA_AGENT_ENABLED=true`, leave `QA_LINEAR_ENABLED` and `QA_AUTOFIX_ENABLED` unset. From now on the
   Monday schedule runs too, still as a dry run.
4. Run the workflow by hand from `main` with `dry_run` on (the default), first with one charter
   (`charters: c2-chat-power-user`; separate several ids with commas or spaces), then with all of them. Read the
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

| Secret                                         | Used by                                      | What it is                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QA_ANTHROPIC_API_KEY`                         | explore, judge, fix, real-AI backend, replay | one key from a dedicated Anthropic workspace with a monthly spend limit: the agent, the judge, the fix agent and the app's backend in real-AI sessions |
| `QA_TINFOIL_API_KEY`, `QA_TINFOIL_ENCLAVE_URL` | real-AI backend, replay                      | QA-only Tinfoil access for the GLM models                                                                                                              |
| `QA_EXA_API_KEY`                               | real-AI backend, replay                      | QA-only Exa key for search and link previews                                                                                                           |
| `QA_LINEAR_API_KEY`                            | file, publish                                | Linear key for team Thunderbolt: read issues and labels, create issues and comments, upload files                                                      |
| `QA_APP_CLIENT_ID`, `QA_APP_PRIVATE_KEY`       | publish                                      | the GitHub App below                                                                                                                                   |
| `QA_HEARTBEAT_URL`                             | report                                       | optional BetterStack heartbeat, sent after a scheduled run on `main` that worked                                                                       |

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

Caps live in one place per step type: the `env` block at the top of `qa-weekly.yml` for explore and fix (budget,
turns, timeout), and the constants at the top of `verify.ts` for the judge. The first values are generous on
purpose: explore $10 / 400 turns / 60 min, fix $20 / 200 turns / 60 min. Per leg, at most 20 findings are replayed
and 15 judged, and a judge leg spends at most $2 (a call is admitted only if its worst case fits: prompt bytes plus
`max_tokens`, at Opus prices). Findings over a cap are listed as deferred and never filed. The app's own provider
calls in real-AI sessions are **not measured**: watch the QA provider keys' dashboards.

**Rule:** per step type, cap = the highest value observed (the 95th percentile once there are 20 samples) + 50%,
for cost, turns and duration. The report's "Calibration hint" table computes it from the run's own sessions.
Recalibrate after the first two scheduled runs and whenever a charter changes. The Anthropic workspace's monthly
limit stays the hard ceiling.

Measured locally on 2026-09-30 (Sonnet 5.5 explorer, Opus 5.5 judge and fix agent, CLI 2.1.285):

| Step                                                         | Sessions | Cost               | Turns   | Duration    | Stop                  |
| ------------------------------------------------------------ | -------- | ------------------ | ------- | ----------- | --------------------- |
| explore, fake AI (c1, c2, c4, c6, c8)                        | 12       | $0.44–1.22         | 91–227  | 2.6–6.2 min | all finished          |
| explore, real providers (c3, c5)                             | 4        | $0.48–1.11         | 81–134  | 3.3–7.4 min | all finished          |
| explore, canary leg (c8, hand-written canaries)              | 2        | $0.94–1.03         | 154–162 | 4.6–4.8 min | all finished          |
| judge (Opus 5.5, one call per finding, 4–5 findings per run) | 4 runs   | $0.05–0.08 per run | –       | –           | –                     |
| fix agent (one overflow bug)                                 | 1        | $0.26              | 21      | 3.1 min     | finished, spec passes |

A full set of charters plus the canary leg cost about $7 in explore sessions. c7 has not been measured. Later
samples (2026-10-02): c4 on the real AI, $1.72 and 283 turns in 9.2 min, plus $0.14 on the app side; the free
session, $0.49 and $0.50 per platform plus about $0.25 on the app side for sessions and replays. With the table's
numbers the rule gives explore ≈ $1.8 / 341 turns / 11 min and fix ≈ $0.4 / 32 turns / 5 min. That is one local
sample per charter, so keep the initial caps until two scheduled runs have reported.

## Cut sessions

A session stopped by its budget, its turn cap or the step timeout keeps every finding it wrote, and they are
verified like any other. The report lists cut sessions first, under "INCOMPLETE". A timed-out step leaves no
execution file: its cost shows as $0.00 (check the Anthropic workspace's usage) and its attempts stay unchecked.
When every explore session of the weekly charters, or of the canary leg, ends in an error or a timeout,
`report.ts summary` exits 1, so `notify-on-failure` fires.

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

The Monitoring / E2E Tests project lead owns `functions.json`, the charters, `noise.txt`, `known-issues.md` and the
canary charter table in `scripts/canaries.ts`, and turns confirmed specs into permanent tests. Add a `known-issues.md` entry for every bug that is
tracked or accepted, and remove it once it is fixed. Whoever triages on Monday puts one `qa:` label on every
`qa-agent` ticket.

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
- the explore job's transcript cut and secret check (the same `transcript.jq` and an exact-value
  `grep` ran locally on real sessions' output);
- `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` passed through the action (probed with the CLI only);
- the bubblewrap sandbox in the explore and fix jobs, including whether the Playwright MCP's Chromium still starts
  inside it and reaches the stack, whether the fix agent's own spec run can still reach the local stack from inside
  it (the separate spec replay step runs outside the sandbox), and the fix output's secret scan (run locally as a
  script);
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
  is real, which is how a hand-written skill-delete canary was missed locally (recall 2/3).
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
- Google is covered only through the fake Google, by the free session's `calendar-planner` and `inbox-triager`
  cases. Real Google and Microsoft accounts stay out of scope, and Microsoft has no fake yet.
