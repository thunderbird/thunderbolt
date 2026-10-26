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

| Zone                     | Jobs                                                                       | Holds                                                                                                                                                       | Never holds                                                                                              |
| ------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| A: explore and verify    | `explore`, `explore-native` on Android, `replay`, `replay-native`, `judge` | the QA Anthropic key (explore, judge); QA provider keys in real-AI backends (other OS users)                                                                | Linear key, any write token. The replay steps hold **no secret**: they run model-written specs and flows |
| B: file                  | `file`                                                                     | the Linear key                                                                                                                                              | an LLM, a browser                                                                                        |
| C: fix                   | `fix`, then `publish`                                                      | `fix`: the QA Anthropic key, read-only token. `publish`: GitHub App token + Linear key                                                                      | `fix`: any provider key. `publish` runs no LLM and checks the patch in code                              |
| D: native explore, macOS | `explore-native` on iOS                                                    | the QA Anthropic key, only in the `env:` of the canary, session and secret-scan steps                                                                       | any provider key, the Linear key, any write token, an agent that edits code                              |
| E: check a patch         | `verify-native-build`, `verify-native-run`, `verify-real`                  | nothing, except `verify-real`: QA provider keys in a backend that runs as another OS user, from a fresh checkout that serves the fix job's patched frontend | the Linear key, any write token, an LLM                                                                  |

Every confirmed finding goes to the fix agent, whatever its area, and a person reviews every draft PR. `publish`
refuses a patch only to protect the supply chain and the verification (`isDenied` in `fix.ts`). It refuses a patch
that touches `.github/` or `e2e/` (every repro spec and visual check imports its helpers). It refuses one that
touches, in any folder, a dependency manifest, lockfile or build-tool file (`package.json`, `bun.lock`,
`package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `bunfig.toml`, `.npmrc`, `.nvmrc`,
`.tool-versions`, `Cargo.toml`, `Cargo.lock`, `.cargo/config.toml`, `rust-toolchain.toml`, Gradle files and the
Gradle wrapper, `Podfile`, `Gemfile`, `Package.resolved`, `Package.swift`, `requirements*.txt`, `go.mod`, `go.sum`),
or a git hook under `.husky/` or lint-staged config (`.lintstagedrc*`, `lint-staged.config.*`), which run on a
developer's machine at their next commit. It refuses the Vite, Playwright and TypeScript configs (`vite.config.*`,
`playwright.config.*`, `tsconfig*.json`), which the dev servers, the build and the checks run or obey. It also
refuses a patch that adds or changes a symlink or submodule, or that matches a secret pattern, and a visual fix
whose `verify.json` is not JSON or lacks a boolean field. App code of any kind, `src-tauri/` and `backend/drizzle/`
included, can be changed. The repo is public, so a security fix's PR names only its ticket and never says
"security": no finding text and no regression spec, which a person adds after the fix merges.

In the fix job the dev servers reload the agent's edits outside its sandbox, so they run as the OS user `qa-dev`
(`QA_BACKEND_USER` with `stack.sh start dev`). A step right after the start fails the job if a process of the job's
user listens on 8005, 1424 or 1425 (`ss` names the owner only of the caller's own sockets), and `stack.sh lock` then
takes root away before the agent starts. Code the servers reload cannot read the agent's environment, which holds
the key. sudo makes itself unkillable by the job's user, so before the lock `stack.sh start` adds one sudoers rule
that lets that user run exactly `kill -TERM -1` as `qa-dev` and nothing else; the stop uses it and fails when a
server keeps running. Right after the session, before any code the agent wrote runs outside its sandbox, one step
greps the whole checkout for the key, `node_modules` included (the agent can write it and the real-AI build bundles
it). Only `.git` is left out: the agent may not edit it or run git. No later step holds the key: patched code that
runs afterwards (the visual check, the real-AI build) could leave a process behind or change `$GITHUB_ENV` and
`$GITHUB_PATH`. The upload's own scan looks for token shapes only. Every scan clears the startup and preload
variables and calls its tools by absolute path, since GitHub prepends `$GITHUB_PATH` even to a step's own `PATH`.

The fix agent's commands run in the fix job's checkout, so after the session nothing in that tree is trusted with a
provider key. Zone E keeps the patch away from every key. `verify-native-build` applies the patch and builds the app
with no secret, and uploads only the app. `verify-native-run` installs that app from a fresh checkout and writes the
verdict there. A real-AI web fix is checked in `verify-real`: a fresh checkout starts the real-AI stack as in the
`real` replay leg and serves the patched frontend, which the fix job built. The backend there is the one from before
the patch, so a fix that needs backend code fails this check and goes to a person. `publish` reads one verdict per
native platform of the bug and the real-AI verdict, and a missing verdict counts as a failure. The verdicts keep
keys away from the patch; they are not proof against a patch built to cheat. The patched build in
`verify-native-build` runs with sudo, and on iOS the patched app is a process of the job's user, so either could
forge a verdict. The fix job's own verdicts (the spec replay, the visual check's `verify.json`) also run in the
agent's checkout, whose `node_modules` its test runs could rewrite and `publish` does not check. The most a forged
verdict does is open a draft PR, which a person reviews.

Only the `build` job saves caches, because it runs before any untrusted code. `build-native` also runs before it.
The judge runs in a fresh job, because the replayed specs may have changed files in the replay job's checkout.

The browser tools can write files anywhere in the explore job's checkout, so no repo code runs there after the
explorer: the stack is stopped inline, a checksum of every tracked file must still match, and the session output
must hold no key the job has, or nothing is uploaded. Metrics and coverage are computed later, in the report job.
The explore and fix agent steps set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`, so no command they start inherits the
Anthropic key, and both jobs install bubblewrap, which the scrubbed CLI needs to run those commands in a sandbox.

Never add `--allow-unrestricted-file-access` to `mcp.json` or set `PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS`.
The MCP blocks `file:` URLs by default, and that block keeps local files out of the explorer's reach.

### Native explore on macOS

On the macOS runner any process of the job's user can read the Anthropic key in the initial environment of
`claude`, even with the scrub and Seatbelt, as measured on the runner. Zone D therefore rests on a different
guarantee: the model cannot start any process. Five conditions hold it up. `explore.sh run` sets (a), (b), (c) and
(e) for an `ios` or `android` session, and the workflow holds (d). It refuses `c7-two-devices-ios`: its second browser could write
anywhere in the checkout. Only `c7-two-devices-android` gets that browser.

- (a) The Maestro gate (`scripts/maestro-gate.ts`, `mcp-maestro.json`) is the only path to the device. It sends
  Maestro only flows that pass the allow list in `scripts/maestro-flow.ts`, and brings the app back to the front when
  a command leaves it. The app is in front when the top element bears its name (iOS) or a view's resource id starts
  with `<appId>:id/` (Android, whose top element has no name).
- (b) No Bash: `--tools Write`, `--disallowedTools Bash`, and the hook denies it too.
- (c) Maestro's cloud tools, `list_devices` and `open_maestro_viewer` never reach the model: the gate does not offer
  them, and they are disallowed by name.
- (d) No copy of the key in a file the job's user can read. In `explore-native` it lives only in the `env:` of the
  canary step, the session step and the secret scan after the session, never interpolated in `run:` and never
  written to `$GITHUB_ENV`. The scan runs once `claude` has exited, so the model can no longer act.
- (e) Write only inside the session dir: the rule `Edit(//<session dir>/**)` and the hook (`scripts/native-hook.ts`),
  which resolves links before it compares paths.

The hook runs before every call (`matcher: "*"`) as `bun <repo>/.github/qa/scripts/native-hook.ts || exit 2`,
because Claude Code lets a call through when its hook cannot run. It sits in the `settings.json` of an otherwise empty
`CLAUDE_CONFIG_DIR`, read through `--setting-sources user`. `--strict-mcp-config` keeps any other server named
`maestro` from loading and getting the hook's allow. The scrubbed CLI ignores `--permission-mode`, so the command has
none. The session dir is passed as a path without links, because the Edit rule does not follow them: a Write to
`/tmp/…` misses a rule on `/private/tmp/…`. The gate log (`<out>/<session>.gate.log`), the WebView log and the
backend log stay outside the session dir, since the model can write anywhere inside it.

Before any session, `explore.sh canary <session> <out>` runs a short `claude-haiku-5-5` session with the same
settings (4 turns, $0.05). It asks for a `run` with `runScript` and a Write to `/tmp/qa-canary-outside.txt`, and
passes only when the gate log shows the hook's `allow mcp__maestro__run` (so the hook runs on MCP calls too), the
gate's `deny run`, the hook's `deny Write`, and the file does not exist. If it fails, no session runs. It prints the session's result line and never a tool result. The CLI stays pinned to
`@anthropic-ai/claude-code@2.1.303`, which is the version tested for the hook, the scrub and the Edit rule; a new version
has to pass the canary and the Edit rule again. iOS sessions use the fake AI only (no provider key on the Mac), and no
agent that edits code runs there.

In CI, nothing a native session runs comes from the checkout. On Android, c7's second browser can write anywhere in
it while the key is in the environment, and the same steps run on every native leg. Before the canary,
`explore.sh harness <session> <dir>` compiles the gate and the hook with `bun build --compile` into standalone
binaries that read nothing from the checkout or `node_modules`, built with the `--no-compile-autoload-*` flags so
they ignore a `bunfig.toml` (whose `preload` is code) or `.env` where they start. It copies `explore.sh` and, for
c7, the layout probe, installs the second browser's MCP server there, and writes the session's MCP config pointing
only at those files. The workflow makes the dir read-only and runs `<dir>/explore.sh canary` and `run` with
`QA_HARNESS=<dir>`. In that mode `claude` starts in an empty temp dir, so neither it, the hook, the gate nor the
browser's MCP server starts in the checkout, and `run` skips its summary, so no repo code runs in a step that holds
the key after the session. The stream goes to `<out>/<session>.run.jsonl`, next to the gate log and outside the
session dir the model can write to; the save step builds `execution.json` and `transcript.json` from it without
the key, after the tripwire and the secret scan.

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
the runner's memory. The `real` and `android-real` replay legs are the only replay legs with an environment
(`qa-agent`), for the keys their start step hands over. Their replay steps hold none. Android's real-AI explore legs
and `verify-real` start the stack the same way.

Residual risk: the lint refuses Playwright's file writes by name. That is a denylist, so a write API added in a
Playwright upgrade would get through and could rewrite the checkout that later replay steps and the backend run
code from. The fallback is a checkout the job's user cannot write during replay.

## Pipeline and files

1. **build**: the normal, onboarding (c1) and canary builds, then the guard: a fresh stack must pass
   `control/stack.spec.ts`, or the run stops and `notify-on-failure` fires.
2. **explore**: one leg per charter and platform, named `<charter>-<platform>` (`c4-skills-projects-phone`), and one
   per free-session platform (`free-<case>-<platform>`); `legs.ts` plans them. A canary adds its session's leg on the
   canary build. Each runs with `claude-code-action`, the Playwright MCP (`mcp.json`, plus `mcp-two-devices.json` for c7's second browser) and the
   prompt `explore.sh prompt` builds: `prompt.md`, the same for every session so they share its prompt cache, then
   the platform's driver block (`drivers/playwright.md` or `drivers/maestro.md`; a native c7 gets both), the
   session's own block, and the charter with its functions. Attempts, findings and repro specs are written as they happen, so a cut session
   keeps its work. `mcp.json` loads `layout-probe.js` into every page (`--init-script`, a path relative to the repo
   root, where the session runs). The probe writes `[qa-layout] ready` once per page load and one
   `[qa-layout] <kind> <target>` line per layout problem (kinds `overflow-page`, `overflow-text`, `offscreen`,
   `covered`, `behind-keyboard`, `focus-covered`, a fixed or sticky box over part of the focused text field, and
   `focused-clipped`, a scroll box or the screen edge cutting off the focused field while the keyboard is open),
   all with `console.error`, so they pass the MCP's `--console-level error`. A problem line is a `layout` finding. The MCP does not put console text in a tool
   result: a navigate result holds a count of console errors and a link to the lines the load wrote, in a log file
   under `--output-dir` (absolute, because of `--file-paths absolute`). The explorer reads the lines with
   `browser_console_messages`. `report.ts` follows each navigate link inside the session's own directory (the link
   is cut at its `mcp/` or `mcp-b/` part, so another runner path still resolves) and lists a session whose page
   loads lack the ready line under "Layout probe", because a clean layout there proves nothing. A native `run`
   result whose gate output has no `[qa-layout] ready` line counts the same way, and the report says "screens
   without a measurement" for both. Maestro tools count in coverage like browser tools: `run` is an action,
   `inspect_screen`, `take_screenshot`, `read_logs` and `cheat_sheet` are reads, and a reload on native is a `run`
   whose `yaml` has `launchApp` after `stopApp` or `killApp`. A `run` the gate denied (reply starts with `denied:`)
   is dropped with its reply. A quote must come from what the app showed: the `run` success envelope, `[qa-gate]`
   lines, `Saved to` lines and the whole `cheat_sheet` and `take_screenshot` replies do not count. `noise.txt` turns
   a `[qa-layout]` line filed as a `console-error` into an observation. The explorer also takes a screenshot of
   every new screen and sees it (`--image-responses allow`). A defect it sees there and the probe did not report is
   a `visual` finding, which names its screenshot (`mcp/<file>`) instead of a repro spec. `--output-dir` is
   `<session>/mcp` (`mcp-b` for c7's second browser), and the job uploads its screenshots and console logs with
   the session.
3. **replay** (`verify.ts replay`): schema, oracle (`noise.txt`) and lint gates, then each spec 3 times. 3 of 3
   failures confirm a finding, 2 of 3 for the real-AI charters (`realAiCharters` in `findings.ts`); 1 or 2 are flaky
   (report only), 0 is dropped. c7 replays on Postgres + PowerSync, the real-AI charters against the real providers,
   the rest on pglite with the fake AI. A `visual` finding skips the lint and Playwright and takes no place under
   the replay cap. It is confirmed when its screenshot exists, a browser screenshot result in the session's
   transcript names it, no Write or Edit call touched it, and it is a PNG or JPEG within the API's image limits
   (10 MB base64-encoded, 8000 px per side). Otherwise it is dropped. A native finding has a Maestro flow
   (`repro_flow`, `repro/<n>.yaml`) instead of a spec, except c7 on Android, whose browser-side bugs keep a spec. The
   session dir decides which, never the finding's own `charter` or `viewport`: a finding whose repro does not fit
   its session is dropped at the schema gate, and every other finding takes its session's platform as its
   `viewport`. The flow passes the gate's allow list with `${EMAIL}` as its only variable, and `verify.ts replay --native` runs it 3
   times through `replay-native.ts`, each time on a fresh install (the onboarding build for c1, the plain one
   otherwise), with a video under `<out>/videos/`. `control/stack.yaml` runs 3 times first on the plain build; one
   failure marks the stack unhealthy and no flow runs. On Android the install also warms the app up (as
   `native.sh install` does) and each run ends with a `maestro hierarchy` for the tree's `behind-keyboard` line.
   A `layout` run fails when the probe (or, on Android, that tree rule) logs the quoted `[qa-layout]` line during it, a `console-error`, `page-error` or `http-5xx` run when a new WebView or backend log
   line holds the evidence (cut at the console mark and normalized like the fingerprint), any other run when the flow
   fails. Both sides are compared as the gate showed them to the explorer (`cleanLogLine` in `sanitize.ts`: secrets
   hidden, foreign links removed). A run whose driver did not start (`iOS driver not ready in time`) is run once more and never counts as the
   bug. A `layout` run whose flow failed before the quoted line showed never reached the screen: it is inconclusive
   and run again, at most 3 extra runs per finding. The finding is confirmed when the line shows in 3 of 3 conclusive
   runs (2 of 3 for the real-AI charters), and flaky when fewer than 3 runs are conclusive after the extra runs. A run
   whose flow passed without the line still counts as not shown. A `layout` flow whose last command is `assertVisible`
   or `assertNotVisible` is dropped at the lint gate: it would fail on every run without the line, so each of those
   runs would be rerun as inconclusive and the finding would get up to 6 tries. A native leg also keeps to its job's
   time: a run starts only if it can end 2 minutes (for the sanitize and the upload) before replay-native's 90
   minutes, counted from `QA_LEG_START`, which the job's first step records, so the setup is counted as it ran. A run
   is taken to last as long as the slowest so far (at least 2.6 minutes). An extra run must also leave room for the 3
   runs each later finding is owed. A finding left with fewer than 3 counted runs is flaky, and `replay.reason` says
   why. A flow that waits for the first screen after sign-in (`Welcome to Thunderbolt!` on the c1 build,
   `Ask me anything…` otherwise; three dots count as the ellipsis) but never types the code `12345678` is signed in
   by the harness. `control/sign-in.yaml` and a wait for that screen run first as their own `maestro test`, in the same
   launch, and the flow then goes on from its own wait. A run whose sign-in failed never runs the flow and is
   inconclusive, whatever the oracle, so it can never prove a bug. In run 39391108579 no iOS flow typed the code, and
   every run was inconclusive. A flow for a bug on the sign-in screen waits for no later screen, so it runs as
   written. `drivers/maestro.md` gives the model the same sign-in block to copy, and each build's landing wait.
4. **judge** (`verify.ts judge`): one Opus call per confirmed finding with `judge.md` and `known-issues.md`; a
   `visual` finding is judged on its screenshot, a native one on the flow replay ran (the allow list's own
   serialization, read from a path checked like a screenshot's). For a `layout` finding the replayed probe
   line is the proof and a screenshot only context. The default answer is drop. Writes `verified.json`.
5. **file** (`file-findings.ts`): fingerprint dedupe, severity table, ticket caps and roll-ups, secret refusal.
   Dry run unless `--live`. The fingerprint ignores the platform, so findings that share one become one ticket
   whose `**Platforms:**` line lists every platform that found the bug, and an open ticket gets one comment with
   that line. A `visual` finding's fingerprint is its area, function and element (`<role> "<name>"`), never its
   wording; one without an element is refused. Its ticket names the element and embeds the screenshot, uploaded with the content type its bytes declare. A `security` finding uploads no screenshot and no video.
   An Android `layout` finding is refused too, with its reason in the report, until the probe has swept correct
   Android screens clean (see "Known limits"). It still replays and is judged, and an iOS finding of the same bug is
   filed as usual.
6. **fix** (off by default, `fix.ts` and `fix.md`): at most 3 confirmed tickets a week, highest severity first,
   one per fingerprint, from any area. A ticket whose `qa-fix/<fp>` branch still exists waits for a later week.
   A `spec` task's original spec must pass 3 times on the patch. A `visual`
   task has no spec, so the agent first writes `qa-out/fix-<fp>/repro/check.spec.ts` (the depth and `repro/` dir of
   a repro spec, so its imports and the Playwright config work), a check that fails because of the defect; the
   workflow records in `qa-out/fix/<fp>.verify.json` whether it failed without the patch and passed
   with it, and both must be true. The fix job runs that check three times on the patched dev stack, then three
   times on the builds without the patch. A real-AI web task (`real`) is fixed on the fake AI, and `verify-real` runs
   its spec three times on the real providers against the patched frontend; all three must pass. Any check a task
   needs that did not succeed (failed, skipped or cancelled) leaves a diagnosis. An iOS or Android task carries its
   Maestro `flow` instead of a spec: the agent writes the patch on Linux (reproducing the bug on the web at phone
   size in `qa-out/fix-<fp>/repro/web.spec.ts` when it shows there), and a native visual task's check is
   the Maestro flow `qa-out/fix-<fp>/repro/check.yaml`, which fails only on its own assertions. `publish` refuses an
   edited repro flow (`fix/<fp>.yaml`) and a flow or check outside the Maestro allow list. `fix-plan.json`'s
   `verifyNative` lists each native task's flow and the repro flows of the same bug on other native platforms.
   `native.sh verify-build` (job `verify-native-build`) builds the patched app in a temporary worktree, and
   `native.sh verify-run` (job `verify-native-run`), from a checkout the patched build never ran in, runs the flow
   three times on it with no key; a layout or log oracle also
   needs the probe's ready line in every run. With `unpatched` (a visual check, or an Android real-AI task, which
   the keyless run can only check on the fake AI) the flow also runs on the build without the patch and must fail
   there every time. A native fix PR adds no regression spec. `publish` needs `passed: true` from every platform in
   `verifyNative` for the fingerprint, web tasks included, and from `verify-real` for a real-AI web task. Only then
   does it open a draft PR on `qa-fix/<fp>`. Otherwise it writes the diagnosis (for a native platform, "the flow still
   fails on the native platform") and the ticket gets `Human Required`. `preview-deploy.yml` deploys no preview for
   `qa-fix/*` PRs.
7. **report** (`report.ts summary`): the job summary.

Output goes to `qa-out*/` (gitignored). `fixtures/` holds the files the charters upload.

## Canaries

A canary is a bug we know is there, used to check that the explorer still finds bugs. Each week the build job runs
`scripts/canaries.ts`. It takes the `fix:` commits merged to `main` in the last 8 weeks, newest first, and keeps
at most two that:

- change app code under `src/` (tests, test helpers, docs and translations are left alone);
- touch no sensitive path (`isSensitive` in `canaries.ts`);
- map to a charter in the script's one table (c2 to c6), one canary per charter, both on the same kind of AI;
- change no runtime code outside `src/` (`shared/`, `backend/`, `public/`, `index.html`, the Vite config): the reversal
  covers `src/` only, and the canary backend runs from the unpatched checkout;
- can be reverted on the current tree with `git apply -R --check`.

The canary build reverts those fixes. It runs before the legs are planned: if it fails, the run warns, the tree is
restored and the canary leg is skipped as if nothing qualified, so a bad canary never costs the weekly run. Each one
gets an explore session with its charter on that build, so at most 2 sessions a week. A canary counts as found only when a judge-confirmed finding from its charter fails on the
canary build and passes on the normal build. The report lists each fix (title, sha, charter, found or missed), and
"Real bugs seen in the canary leg" lists confirmed findings that still fail on the normal build: real bugs, not
counted. Canary findings are never filed.

To calibrate by hand, run the workflow with the `canaries` input set to up to two commit SHAs. Those commits are used
as they are, without the checks above except that each must have a charter, its reversal must apply, and both must use
the same kind of AI. A commit that cannot be a canary fails the build job instead of being skipped; a canary build
that fails still only drops the canary leg.

Why real fixes: they are bugs users really hit, nobody tuned the prompts for them, and they rotate by themselves as
new fixes land. When nothing qualifies, the leg is skipped and the report says so; the build log has one line per
skipped fix with the reason. Most often a later change touched the same lines; that clears up with the next fixes.

## Functions, coverage and the free session

`functions.json` lists per area (c1 to c7) what must work on every platform: an id, an observable outcome, and `reload: true` when
the outcome must survive a reload. A function that spans two areas has one owner. Each charter in `charters/` names
the function ids its steps cover. Integrations are in no list; Google is covered through the fake Google below.
The old phone-only charter c8 is gone: every charter runs on desktop and phone, and its content moved into c2, c4 and c6.
Its `*-fit` functions were dropped because the layout probe covers screen fit.

**Coverage** counts a function only when a `passed` or `failed` attempt quotes text a browser tool returned in that
attempt's window, after a browser action, and, for a passed `reload` function, after a navigation that follows a
change.
Text the explorer typed never counts, and a session without a transcript covers nothing. The check proves the quote
was seen at the right moment, not that it shows the outcome: sample covered functions by hand.

The **free session** plays one case from `journeys.json` (a person, a goal with no steps, and `facts` the explorer
uses to judge the AI's answers) on every platform in `platforms.json`, with the real AI.

- `explore.sh journey` picks the case: weeks since 1970 modulo the number of cases, so every case runs once before
  any repeats. A dispatch's `journey` input forces one; `charters: free` runs only the free session.
- A dispatch's `charters` input takes charter ids (every platform), session ids (one platform) and `free`, e.g.
  `c4-skills-projects,c2-chat-power-user-phone,free`. Canary legs follow the same selection.
- Add a case by appending an object with a new `id` (it shifts the rotation once). `bun run test:qa` checks it.
- A platform is one entry (an `id` without a hyphen, a `driver`, a `runner`, a viewport, an MCP config, `realAi`)
  and one explore leg. `ios` and `android` use the `maestro` driver and plan into `nativeLegs` and `nativeVerify`,
  apart from the web `legs` and `verify`. The grid has two written exceptions, both in `skippedSessions` in
  `legs.ts`: `c7-two-devices-ios` is left out because the macOS runner has no Docker for the Postgres and PowerSync
  containers, and iOS sessions never use the real AI providers (`realAi: false`), so c3, c4, c5 and the free session
  run there on the fake AI. Canaries stay on the web.
- `free-*` legs are real-AI charters: two failures in three confirm, and their web fixes are checked on the real
  providers (Android fixes on the fake AI, see step 6). One case
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

# One session, named <charter>-<platform>; the platform sets the viewport and the MCP config. The last argument is
# the budget cap in USD (default 2).
ANTHROPIC_API_KEY=… .github/qa/scripts/explore.sh run c2-chat-power-user-desktop qa-out 4
ANTHROPIC_API_KEY=… .github/qa/scripts/explore.sh run c2-chat-power-user-phone qa-out 4
```

- **c7** needs its second browser:
  `QA_MCP_CONFIG='.github/qa/mcp.json .github/qa/mcp-two-devices.json' … explore.sh run c7-two-devices-desktop qa-out 4`.

- **The free session** runs one case on one platform per call, named `free-<case>-<platform>` (`explore.sh journey`
  prints this week's case). Like every session it takes its viewport and MCP config from `platforms.json`, and it needs the real-provider
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
bun .github/qa/scripts/canaries.ts --out /tmp/qa-canaries.json --patch /tmp/qa-canary.patch # or --only <sha>[,<sha>]
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
`.github/qa/scripts/stack.sh serve dev` from that checkout (it serves the app on 1424 with onboarding skipped and on
1425 with onboarding on, so a fix for an onboarding finding can be verified) and the flags of the `fix` job.
Collect the patch like the workflow does, then `bun .github/qa/scripts/fix.ts publish --out qa-out --fp <fp>` without `--live` shows the
commit and the PR it would open.

Every out dir must sit directly under the repo root: the specs import `../../../e2e/helpers` and
`../../../.github/qa/layout`.

The scripts' tests and type check: `bun run test:qa` and `bunx tsc -p .github/qa`. The layout probe
(`layout-probe.js`) has its own tests on static pages in `fixtures/layout/`:
`bunx playwright test --config .github/qa/playwright.config.ts --project probe`. The `qa` job in `ci.yml` runs all
three when a QA file changes.

## Native platforms

The iOS and Android sessions drive the Tauri app, not a browser. `scripts/native.sh` builds the app against the QA
stack, boots a device, installs the app and streams the WebView console; `stack.sh serve native` is the stack for
it: the backend and the fakes, with no Vite, since the app carries its own frontend.

```sh
# Stack: backend, fake AI, fake MCP and fake Google. The backend allows the WebView origins
# (tauri://localhost on iOS, http://tauri.localhost on Android).
.github/qa/scripts/stack.sh start native

# Builds, one per onboarding setting like the web ones (iOS takes several minutes, Android needs the SDK and NDK).
.github/qa/scripts/native.sh build ios /tmp/qa-ios-onboarding onboarding   # -> "Thunderbolt Dev.app"
.github/qa/scripts/native.sh build ios /tmp/qa-ios
.github/qa/scripts/native.sh build android /tmp/qa-android                 # -> app-debug.apk

# A booted device (its id on stdout), the app on it, and the console in the background.
udid=$(.github/qa/scripts/native.sh device ios)
.github/qa/scripts/native.sh install ios "$udid" "/tmp/qa-ios/Thunderbolt Dev.app"
.github/qa/scripts/native.sh logs ios "$udid" /tmp/webview.log

# A session on it: the canary first, then the session (both need ANTHROPIC_API_KEY). The backend log is the one
# `stack.sh start` writes. QA_DRY_RUN=1 prints the claude command and its hook settings instead.
export QA_DEVICE_ID=$udid QA_WEBVIEW_LOG=/tmp/webview.log QA_BACKEND_LOG=/tmp/qa-stack.log
.github/qa/scripts/explore.sh canary c2-chat-power-user-ios qa-out && .github/qa/scripts/explore.sh run c2-chat-power-user-ios qa-out 4

# Replay the native findings: no keys in this shell, the same two logs, both builds.
bun .github/qa/scripts/verify.ts replay --out qa-out --native ios --device "$udid" \
  --app "/tmp/qa-ios/Thunderbolt Dev.app" --app-onboarding "/tmp/qa-ios-onboarding/Thunderbolt Dev.app"

# Check a fix's patch: build it in a temporary worktree (onboarding for c1), then run the finding's flow three times
# on it. The flow must sit in qa-out, whose verified.json holds the finding. A visual check or an Android real-AI
# session also gets the unpatched build as the last argument. The patched build runs the patch's code, so in CI the
# run happens in another job on a fresh checkout.
.github/qa/scripts/native.sh verify-build ios qa-out/fix/<fp>.patch <session> /tmp/qa-ios-patched
.github/qa/scripts/native.sh verify-run ios "$udid" "/tmp/qa-ios-patched/Thunderbolt Dev.app" \
  qa-out/<session>/repro/1.yaml <session> qa-out/fix/<fp>.verify.json

.github/qa/scripts/native.sh stop-logs /tmp/webview.log
```

`config <platform> <out-json> [control]` is the Tauri config `build` uses: `tauri.dev.conf.json` with the
stack's two extra `connect-src` origins (`http://localhost:8005`, `http://127.0.0.1:9880`, read from `stack.sh`), and
without the dev `identifier` on Android, whose Gradle project has no `.dev` package directory. Its
`beforeBuildCommand` puts `layout-probe.js` into `dist/index.html` as an inline script, so every native QA build
logs the probe's `[qa-layout]` lines to the WebView console, where the Maestro gate reads them. The Maestro tree
cannot measure layout itself: it has no stacking order and leaves out unlabelled boxes. `build` takes the
`VITE_*` settings from `stack.sh` too. The app ids are `net.thunderbird.thunderbolt.dev` (iOS, "Thunderbolt Dev")
and `net.thunderbird.thunderbolt` (Android). `build` puts back the tracked files under `src-tauri/gen` that Tauri
rewrites, so `git status` stays clean; never commit them.

The positive control shows, per platform, that the layout check fires when the screen is broken. The
canaries of the web legs stay web only (they revert real fixes in `src/`); this plays their part on the native apps and
does not depend on the iOS keyboard bug. `build <platform> <out-dir> control` adds `control/cover.js` after the probe:
while a text field has focus, a fixed button reading `qa-control-cover` sits over the lower half of it, with a role and
visible text because the WebView's accessibility bridge skips a bare div. Install that build and run
`native.sh control <platform> <device> [out-dir]`. It plays `control/native-control.yaml` (the sign-in screen of the
build without onboarding, a tap on Email), reads the WebView log, takes `maestro hierarchy`, prints the ready line and
the probe's lines, and exits 0 only when the keyboard is open (the tree's `inputView` on iOS, Gboard's
`keyboard_holder` on Android) and the probe logged `[qa-layout] focus-covered textbox "Email"`. On the plain build it exits 1, and
a log without the probe's ready line (a dead stream, a build without the probe) says so instead. The build deletes
`dist/` when it ends, because the cover is written into `dist/index.html`.
`controlVerdict` in `native-layout.ts` holds the rule; its tests use a run recorded on the simulator. A finding whose
`repro_flow` is `native-control.yaml` and whose evidence is that line replays `confirmed` on the control build and
`dropped` on the plain one.

On this VM `QA_IOS_DEVICE=68705E07-F13D-4557-A925-2BF960A0A105` (an iPhone 17 Pro Max simulator) picks the device; with it unset,
`device ios` creates an iPhone 17 Pro Max on the newest iOS runtime. Two scripts share the machine: take
`/tmp/qa-stack.lock` before the stack and `/tmp/qa-sim.lock` before the simulator (`mkdir`, an `owner` file, `rm -rf`
at the end), and shut the simulator down when you booted it.

Traps, each of which has cost a run:

- The second iOS build fails with `Directory not empty` while `src-tauri/gen/apple/build/arm64-sim` exists. `build`
  deletes it first.
- A hardware keyboard keeps the on-screen one from opening, and every keyboard check then measures nothing.
  `device ios` turns `ConnectHardwareKeyboard` off before it boots the simulator.
- `simctl addmedia` aborts on a file it cannot read as media, even when the Maestro step says `optional`, so
  `device ios` adds only `fixtures/*.png`, never the `.txt` files.
- The console reaches the iOS system log only with `WebKitDebugLogsPageMessagesToSystemConsoleEnabled` set, which
  `device ios` does, and lines logged before `log stream` attaches are lost, so `logs ios` returns once the
  stream's `Filtering the log data` header shows up. Piping it into `tail` hangs the shell; it runs in the
  background and `stop-logs` stops it by pid.
- On macOS the stack must run under the system `/bin/bash` 3.2 as well: `serve` polls its servers instead of using
  `wait -n`, which 3.2 lacks.
- The Android console (`Tauri/Console` in logcat) exists only in debug builds, and the APK's target is the host's
  architecture (`aarch64` on an Apple Silicon Mac, `x86_64` on the runner). The build reads `ANDROID_HOME` and
  `NDK_HOME` from the environment.
- On a cold emulator the first opens of a fresh install can hit the 5 s IndexedDB timeout, and the init stops at
  `step0_5_storage_check` (runs 39373388149 and 39380764343, twice in a row there). `install android` opens the app
  until a launch logs `[init] step1_`, up to 4 launches of 30 s each with a stop between them, and fails with the last
  storage check line when none does. Sessions, the control and every replay run start on a warm app, and a bad
  emulator fails at the install instead of later as `stack unhealthy`.

Not proven locally: `device android`, `install android` and `logs android`. They need an emulator, and this VM has
no hypervisor, so they run first on GitHub's runners (KVM, `x86_64`).

### In the weekly workflow

`legs.ts` plans the native sessions into `nativeLegs` and their replay legs into `nativeVerify`, and lists the
sessions the grid leaves out in `skipped`, which the plan step prints as notices. iOS runs on `macos-latest`,
Android on `ubuntu-latest` with KVM.

- **build-native**, one job per platform of the run, before any untrusted code: `native.sh build` with onboarding
  off and on, uploaded as `qa-native-<platform>` and `qa-native-<platform>-onboarding`. Each artifact is a tar of
  the app, because an artifact drops file modes.
- **explore-native**, one job per native session: Maestro 2.11.0 from the official installer on both platforms,
  Claude Code 2.1.303, the app the session needs (the onboarding build for c1), the device, `stack.sh start native`
  and the console stream. `c7-two-devices-android` also gets Postgres, PowerSync, the web build on 1424
  (`stack.sh start qa-dist`) and the second browser's Chromium. The app reaches PowerSync on `localhost:18081`:
  `native.sh device` reverses that port too, and a QA build's CSP allows it. Android's real-AI sessions run the
  backend as `qa-backend` and lock root, as the web real legs do. Then the harness (see "Native explore on macOS"),
  the checksums of the tracked files, the canary and the session. After it, as in the web explore job: the stack and
  the log stream stop inline, the checksums must match, the session output must hold no key, and the upload keeps
  findings, flows, specs, attempts, the reduced `execution.json`, `transcript.json`, the Maestro screenshots,
  `mcp-b/` and `<session>.gate.log`.
- **replay-native**, one job per native artifact (`ios`, `android`, `android-sync`, `android-real`), with no secret:
  both builds, the device, the stack (`android-sync` serves the web build with Postgres, PowerSync and Playwright's
  Chromium for c7's specs; `android-real` the real providers), the console stream, then `verify.ts replay --native`
  with `--leg`, which goes into each video's name so merged legs never overwrite one another. A run takes about
  2.6 minutes on iOS (run 39380764343), so a native leg replays at most 4 findings (`nativeReplayCap`): the control's
  3 runs and up to 6 runs per finding, plus setup, fit the 90-minute job, whose timeout would lose every finding.
  Runs can be slower than that (about 3.5 minutes in run 39391108579), and Android's setup is longer than iOS's, so
  the job's first step records `QA_LEG_START` and `verify.ts` starts no run that might end after the timeout: see the
  replay step above. When the replay fails, the job uploads the stack's and the
  WebView's logs as `qa-logs-replay-<leg>`, except on `android-real`, whose backend held the provider keys.
- The weekly **judge** adds the native legs' candidates to the web ones, like the sync and real legs. A dispatch of
  native sessions only still plans it, so its findings are judged, filed and fixed.
- **verify-native-build** and **verify-native-run** check a native fix (see "Trust zones"). With no patched app,
  `verify-native-run` boots no device and writes no verdict.
- **native-control**, only when a dispatch sets `native_control`: builds the `control` variant per platform, boots a
  device, starts the stack and runs `native.sh control`. It holds no secret and its result is not filed. On Android
  it stops the Gradle daemons between the build and the emulator: run 39391108579 stalled on the storage check only
  in this job, the one native job that builds before it boots. A failed control also uploads the stack's log
  (`qa-logs-control-<platform>`); the WebView log is in the control's own folder.
- Every Maestro process runs with `MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true`, because Maestro's "Analyze with
  AI" banner filled the error a failed replay run keeps.

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
   (`charters: c2-chat-power-user`, or one session such as `c2-chat-power-user-phone`; separate several ids with commas
   or spaces), then with all of them. Read the
   job summary.
5. Set `QA_LINEAR_ENABLED=true` to file for real. The schedule then files live; a dispatch files live only with
   `dry_run` off. A dispatch from another branch is always a dry run.
6. Later, and only after triage shows the findings are worth it: `QA_AUTOFIX_ENABLED=true`.

### Prove a branch before merging

A test workflow triggered by `push` cannot stand in for this one: `claude-code-action` refuses push events, and the
`qa-agent` environment gives its secrets only to the branches it allows. Run the real workflow on the branch instead:

1. A repository admin adds the branch to the `qa-agent` environment (Settings → Environments → `qa-agent` →
   Deployment branches and tags → Add deployment branch or tag rule).
2. `gh workflow run qa-weekly.yml --ref <branch> -f charters=<ids>`. The run takes the workflow file from the branch
   (the Actions page calls the choice "Use workflow from"), so `qa-weekly.yml` must already exist on `main`. A
   dispatch from a branch is always a dry run: nothing is filed or published.
3. The admin removes the rule once the run is over.

This proves every step up to filing. The fix agent and the native verification run only on `main` (the `autofix`
output checks `github.ref`), so the first run after the merge proves them.

### Repository variables

The `build` job has no environment, so these must be repository variables.

| Variable             | Effect                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `QA_AGENT_ENABLED`   | `true` runs the workflow at all (kill switch)                                                           |
| `QA_LINEAR_ENABLED`  | `true` lets `file` and `publish` write to Linear and GitHub                                             |
| `QA_AUTOFIX_ENABLED` | `true` routes confirmed tickets to the fix agent (schedule, or dispatch with `autofix`), only on `main` |
| `CI_ALERTS_ENABLED`  | existing: `notify-on-failure` does nothing until it is `true`                                           |

### Environment `qa-agent`

Used by `explore`, `explore-native`, the real-AI `replay` and `replay-native` legs, `judge`, `file`, `fix`,
`verify-real`, `publish` and `report`. No required reviewers
(the schedule would hang). Limit its deployment branches to `main`.

| Secret                                         | Used by                                      | What it is                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QA_ANTHROPIC_API_KEY`                         | explore(-native), judge, fix, real-AI stacks | one key from a dedicated Anthropic workspace with a monthly spend limit: the agent, the judge, the fix agent and the app's backend in real-AI sessions |
| `QA_TINFOIL_API_KEY`, `QA_TINFOIL_ENCLAVE_URL` | real-AI stacks: explore, replay, verify-real | QA-only Tinfoil access for the GLM models                                                                                                              |
| `QA_EXA_API_KEY`                               | real-AI stacks: explore, replay, verify-real | QA-only Exa key for search and link previews                                                                                                           |
| `QA_APP_CLIENT_ID`, `QA_APP_PRIVATE_KEY`       | publish                                      | the GitHub App below                                                                                                                                   |
| `QA_HEARTBEAT_URL`                             | report                                       | optional BetterStack heartbeat, sent after a scheduled run on `main` that worked                                                                       |

The `QA_` names differ from nightly's on purpose. Each is a QA-only key, and if an environment secret were missing,
a same-named repository secret would be used without warning.

The Linear key is the exception. The QA files into the same Linear team as nightly, so `file` and `publish` use the
existing repository secret `LINEAR_API_KEY`, like `nightly.yml`. It needs to read issues and labels, create issues and
comments, and upload files. `notify` also uses the repository secrets `RESEND_API_KEY` and `LINEAR_API_KEY`.

### Linear labels

Team Thunderbolt needs these labels, or the filer stops and lists the missing ones:

- `qa-agent`, `Bug`, `Security` (filing)
- `Human Required` (`publish` puts it on a ticket whose fix ended in a diagnosis or a rejected patch)
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
(4 on a native leg, whose runs are slow) and 15 judged, and a judge leg spends at most $2 (a call is admitted only if its worst case fits: prompt bytes,
1,600 tokens per screenshot, plus `max_tokens`, at Opus prices). Findings over a cap are listed as deferred and
never filed. The app's own provider calls in real-AI sessions are **not measured**: watch the QA provider keys'
dashboards.

**Rule:** per step type, cap = the highest value observed (the 95th percentile once there are 20 samples) + 50%,
for cost, turns and duration. The report's "Calibration hint" table computes it from the run's own sessions.
Recalibrate after the first two scheduled runs and whenever a charter changes. The Anthropic workspace's monthly
limit stays the hard ceiling.

Measured locally on 2026-09-30 (Sonnet 5.5 explorer, Opus 5.5 judge and fix agent, CLI 2.1.285):

| Step                                                         | Sessions | Cost               | Turns   | Duration    | Stop                  |
| ------------------------------------------------------------ | -------- | ------------------ | ------- | ----------- | --------------------- |
| explore, fake AI (c1, c2, c4, c6, old phone charter c8)      | 12       | $0.44–1.22         | 91–227  | 2.6–6.2 min | all finished          |
| explore, real providers (c3, c5)                             | 4        | $0.48–1.11         | 81–134  | 3.3–7.4 min | all finished          |
| explore, canary leg (old phone charter c8, hand-written)     | 2        | $0.94–1.03         | 154–162 | 4.6–4.8 min | all finished          |
| judge (Opus 5.5, one call per finding, 4–5 findings per run) | 4 runs   | $0.05–0.08 per run | –       | –           | –                     |
| fix agent (one overflow bug)                                 | 1        | $0.26              | 21      | 3.1 min     | finished, spec passes |

A full set of charters plus the canary leg cost about $7 in explore sessions. c7 has not been measured. Later
samples (2026-10-02): c4 on the real AI, $1.72 and 283 turns in 9.2 min, plus $0.14 on the app side; the free
session, $0.49 and $0.50 per platform plus about $0.25 on the app side for sessions and replays. With the table's
numbers the rule gives explore ≈ $1.8 / 341 turns / 11 min and fix ≈ $0.4 / 32 turns / 5 min. That is one local
sample per charter, so keep the initial caps until two scheduled runs have reported.

The native platforms add 15 sessions a week (7 on iOS, without c7; 8 on Android), each with the same caps as a web
session and a Haiku canary before it (4 turns, $0.05). Only c1 has been measured on GitHub (runs 39373388149,
39380764343 and 39391108579): iOS $0.61 to $0.83 and 82 to 104 turns, Android $1.07 to $1.23 and 117 to 137 turns,
10 to 22 minutes a session; each canary stayed under its $0.05 cap. The spec's estimate is $1.50 to $2.50 per native
charter session and $0.80 to $1.30 per free session, so $21 to $35 a week on top of the web sessions; the other
charters are still unmeasured. The turn cap of a native session is the 400 in `explore.sh`, not
`QA_EXPLORE_MAX_TURNS`; the budget and the timeout come from the workflow. Runner time grows too: two native builds
per platform, and every native explore, replay and verify job boots a simulator or an emulator, on macOS runners for
iOS.

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
3. Change `'../../../e2e/helpers'` to `'./helpers'`, `'../../../.github/qa/layout'` to `'../.github/qa/layout'`,
   and `@playwright/test` to `./test` when it imports only `test`, `expect`, `Page`, `Request` or `Route`.
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
  merge of the sync and real candidates from per-artifact directories (run locally as a script);
- the native jobs as this workflow runs them. Runs 39373388149, 39380764343 and 39391108579 ran a copy of it on a
  push trigger, with the c1 sessions only, no environments and no Linear key. On both platforms they proved the
  builds and the app tars between jobs, the Maestro installer, Claude Code from npm, the harness, the canary (denied
  before every session), the sessions and their upload, the gate's foreground check, the replay and judge legs
  running, and a dry filing; on iOS, the positive control; on Android, the keyboard rect from the tree and its
  `behind-keyboard` rule. The agent found the onboarding keyboard bug on its own on both platforms. They left open:
  a native finding confirmed by replay and filed (iOS replays were dropped, flaky or inconclusive, and Android's
  stopped at the stack control); the Android control exiting 0 (its job stalled on the app's storage check every
  time); the fix agent on a native task, since `claude-code-action` refuses a push event; `verify-native-build`,
  `verify-native-run` and `publish` with a real patched app and verdict; `verify-real`; c7 on Android with the
  `android-sync` and `android-real` legs; every charter but c1 and the free session on both platforms; and a full
  `replay-native` leg under the `QA_LEG_START` clock (run 39391108579's iOS replay hit the timeout before it);
- the fix agent's `Edit(**)` rule with its deny list, the two `bun db generate` rules, and the visual check's runs in
  the fix job;
- the narrow `sudo` stop of the `qa-backend` backend in the real-AI legs. Run 39391108579 proved the fix job's dev
  stack as `qa-dev`: its start, the `ss` port check, the lock and the stop through the same rule.

Also:

- The explorer can still stop early by itself. Coverage in the report shows every function it did not reach as
  "unattempted"; the charter owner decides whether an area's list is too long.
- The coverage check trusts the transcript, which the explorer cannot edit, but not what a quote means: an explorer
  can quote a real line that does not show the outcome. Sample covered functions by hand.
- The judge is a model: a borderline finding can be kept in one run and dropped in the next (the Custom provider
  placeholder request in c3 was).
- Repro specs are model-written. A spec that fails before its assertion is dropped by the judge even when the bug
  is real, which is how a hand-written skill-delete canary was missed locally (recall 2/3).
- A security finding's ticket carries no run link, but its finding JSON, repro spec and screenshots still sit in
  the explore and replay artifacts for their 7-day retention. The secret scan before the upload matches key text,
  so it cannot see a key drawn in a screenshot. This repo is public, so any signed-in GitHub user can download
  them.
- A scheduled run acts as the user who last edited the cron line. `claude-code-action` refuses bot actors, so
  that must be a person.
- The fix agent can still run any code (its `bun run test` runs test files it writes), but without the Anthropic
  key in that code's environment. The boundary is that the fix job holds no write token and a person reviews the
  draft PR.
- On CLI 2.1.285, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` forces the permission mode from `dontAsk` to `default`. With
  explicit allow lists both deny every unlisted command and allow read-only ones (probed).
- A real model can fail twice in three replays by chance, and pass twice although the bug is real. The judge drops
  provider outages and expected limitations. A real-AI web fix is checked again on the real providers; an Android
  one only on the fake AI, where its flow must fail without the patch, so a bug that needs a real model goes to a
  person.
- c7 does not run on iOS: the macOS runner has no Docker for Postgres and PowerSync, and its second browser could
  write anywhere in the checkout.
- iOS sessions of the real-AI charters (c3, c4, c5 and the free session) run on the fake AI, because the Mac cannot
  keep provider keys from the job's user. Their `ai-reported-failure` findings are noise for the judge.
- The layout check on iOS and Android is the web probe injected into the QA build. The Maestro tree has no stacking
  order and leaves out unlabelled boxes, so a defect the probe cannot see is left to the screenshot and the `visual`
  finding. One rule runs on the tree, on Android only: the WebView there keeps its full height with the keyboard up,
  so the probe never sees the keyboard, and the gate and the replay report `behind-keyboard` when Gboard's
  `keyboard_holder` overlaps the focused field of the app's window by at least 4 units on both axes. Like the probe,
  the gate shows each such line once per app launch. The keyboard is drawn over
  everything, so that rule needs no stacking order. Another keyboard app would go unseen.
- Android `layout` findings replay, are judged and show in the report, but are never filed or fixed (`refusal` in
  `file-findings.ts`). Layout tickets need a clean probe sweep of correct screens on each platform first, and
  Android's sweep has not run. In runs 39380764343 and 39391108579 the probe logged `covered button`
  for the sidebar's buttons while the screenshots show them uncovered, or off screen with the drawer closed. The
  lines came only as the drawer closed, or as it opened after a relaunch, and on opening only the buttons farthest
  from the left edge were logged, the ones the sliding page uncovers last. The drawer's animation outlasting the
  probe's 500 ms on the slow emulator fits, but no run shows it, so no probe rule was added. Run the sweep on an
  emulator (a keyless GitHub run), fix or exclude what it finds with a fixture, then remove the refusal.
- The canaries are web only; `native_control` plays their part on the native apps, and only when a dispatch asks.
- A real-AI web fix that needs backend code cannot pass `verify-real`, whose backend comes from before the patch, so
  it goes to a person. An Android real-AI fix is checked only on the fake AI.
- Google is covered only through the fake Google, by the free session's `calendar-planner` and `inbox-triager`
  cases. Real Google and Microsoft accounts stay out of scope, and Microsoft has no fake yet.
