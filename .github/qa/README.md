# Weekly exploratory QA

Once a week an AI agent uses the web app the way a person would. It tests one area per session: the area's list
of **functions** that must work (`functions.json`), with a **charter** of steps to follow (`charters/`). A **free
session** also plays one person's goal, with no steps, on every platform. When something breaks, the agent writes a
finding and a Playwright spec that fails because of the bug. Plain code then checks its attempts against what the
browser really returned, replays each spec, asks a second model whether the finding is real, and files the
confirmed ones in Linear. A fix agent works on every ticket the run files and can open a draft PR for each. The
workflow never merges, approves or marks
anything ready.

The workflow is `.github/workflows/qa-weekly.yml`. It runs on Mondays at 07:00 UTC, and by hand with
`workflow_dispatch`. It does nothing until the `QA_AGENT_ENABLED` variable is `true`.

## Trust zones

The explorer reads untrusted pages, so everything it writes is untrusted too. Each job holds only the secret it needs.

| Zone                     | Jobs                                                                                       | Holds                                                                                                                                                       | Never holds                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A: explore and verify    | `explore`, `explore-native` on Android, `replay`, `replay-native`, `judge`                 | the QA Anthropic key (explore, judge); QA provider keys in real-AI backends (other OS users)                                                                | Linear key, any write token. The replay steps hold no secret: they run model-written specs and flows |
| B: file                  | `file`                                                                                     | the Linear key (`route` only reads each ticket's branch name and state with it), a read-only token that lists open PRs                                      | an LLM, a browser                                                                                    |
| C: fix                   | `fix`, then `publish`                                                                      | `fix`: the QA Anthropic key, read-only token. `publish`: GitHub App token + Linear key                                                                      | `fix`: any provider key. `publish` runs no LLM and checks the patch in code                          |
| D: native explore, macOS | `explore-native` on iOS                                                                    | the QA Anthropic key, only in the `env:` of the session and secret-scan steps                                                                               | any provider key, the Linear key, any write token, an agent that edits code                          |
| E: check a patch         | `verify-native-build`, `verify-native-run`, `verify-real`, `verify-tests`, `verify-checks` | nothing, except `verify-real`: QA provider keys in a backend that runs as another OS user, from a fresh checkout that serves the fix job's patched frontend | the Linear key, any write token, an LLM                                                              |

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
refuses a patch that adds or changes a symlink or submodule, or that matches a secret pattern, and one that lacks the
pass of a check its task needs (see "Passes" below). App code of any kind, `src-tauri/` and `backend/drizzle/`
included, can be changed. The repo is public, so a security fix's PR names only its ticket and never says
"security": no finding text and no regression spec. Its branch is `qa-fix/<identifier>`, never Linear's name,
whose slug comes from the ticket's title.

In the fix job the dev servers reload the agent's edits outside its sandbox, so they run as the OS user `qa-dev`
(`QA_BACKEND_USER` with `stack.sh start dev`). That user cannot write to the checkout: `stack.sh start` makes it
the owner of `node_modules/.vite` and `public/@powersync`, and every server it runs gets `CACHE_DIR` in its own
home, where Storybook's Vite plugin keeps its cache. The `qa` job in `ci.yml` starts this dev stack as another user,
loads both pages, stops it and fails on any `EACCES`, `EPERM` or "permission denied" in the stack log. It also runs
when `vite.config.ts`, `scripts/copy-powersync-assets.ts`, `package.json` or `bun.lock` change, since a new plugin
or version can write somewhere new. A step right after the start fails the job if a process of the job's
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
`real` replay leg and serves the patched frontend, which the fix job built. Both jobs run the backend from before the
patch, so `publish` refuses a patch that touches `backend/` or `shared/` when either job checks the bug, and the
ticket goes to a person. `verify-tests` runs the unit tests a web patch adds or changes, which the agent wrote, on a
fresh checkout with no secret, no environment and only `contents: read`, as another OS user (see the fix stage
below). `verify-checks` runs the PR checks on the tree publish would push, every task's, the same way.

### Passes

Code the agent wrote runs in the fix job after the session (the visual check, the real-AI build), and a process it
leaves behind can rewrite or delete any file there before the upload. So no verdict travels in a file. Each check
that passes uploads an artifact named `qa-pass-<fp>-<check>-<run attempt>`, under an `if:` on the outcome of the step
that ran the check, which the runner keeps and no process of the job can change. The checks are `session` (the fix
step succeeded), `replay`, `visual`, `tests`, `real`, one per native platform of the bug (`ios`, `android`), and
`checks` (the PR checks). The artifact holds a marker file whose content nobody reads. `publish` lists the run's
artifact names with the GitHub API (`actions: read`, into `qa-out/artifacts.txt`) and needs a pass of its own run
attempt for every check the task needs: `session` always, `replay` for a fake-AI web spec, `visual` for a web visual
check, `tests` for every web task, `real` for a real-AI web spec, each platform in `verifyNative` for the
fingerprint, and `checks` for every task. A missing pass is a failure, and the ticket gets `Human Required` with the
reason. A missing `checks` pass is the pipeline's failure instead: publish writes nothing to GitHub or Linear and
leaves the ticket for a later run (see the fix stage below). It counts only once every other pass is there, so a
patch that also failed its own checks still goes to a person. Listing names cannot miss, so a normal run shows no
error annotation for a check that did not pass. The diagnosis the fix job writes for a failed check is only the
reason a person reads: deleting it, or writing a result file that says the check passed, opens no PR.

One artifact list spans every attempt of a run, and a download by name or pattern takes the latest artifact of that
name, so an attempt that uploaded none would read an earlier attempt's. The fix output (`qa-fix-<fp>-<run attempt>`),
its status, the patched native app (`qa-patched-<fp>-<platform>-<run attempt>`), the patched real-AI frontend
(`qa-fix-dist-<fp>-<run attempt>`) and every pass therefore carry the attempt, and each job reads only its own
attempt's. A re-run never pairs one attempt's patch with another's build or passes: a job that finds nothing of its
attempt hands the ticket to a person, and publish fails when the status of its attempt is missing. Re-run all jobs to
retry a fix, which runs every fix session again.

The passes keep keys away from the patch; they are not proof against a patch built to cheat. Every upload step's
process holds the runtime token (`ACTIONS_RUNTIME_TOKEN`), and any process of the job's user can read it in that
process's `/proc/<pid>/environ`: Yama restricts attaching only. The runner kills a job's leftover processes only when
the job ends, so a process that code the agent wrote leaves behind can wait for an upload step and take the token.
With it, it can upload an artifact of any name in the run, a pass of any check for any fingerprint included, and
write Actions cache entries in the run's scope. Code the agent wrote runs as the job's user in these places:

- the fix job after the session: the visual check, the real-AI build, and every later `bun` step, since the agent
  can edit `node_modules`;
- `verify-native-build`, whose patched build also has sudo;
- `verify-native-run` on iOS, where the patched app is a process of the job's user.

`verify-tests` and `verify-checks` are not among them. Their tests and checks run as the OS user `qa-test`, which can
read no process of the job's user and has no sudo. The job's user loses root (`stack.sh lock`) before the patch
lands, and the patch lands inside one `fix.ts` process that was loaded before it, so no file of the patched tree
(`fix.ts`'s imports, `bunfig.toml`, `.env`, `stack.sh`) is ever loaded as the job's user. That process refuses a
patch that adds or changes a symlink or submodule before it applies it, since its own writes and `chmod` would follow
the link, and it commits with no git hooks. Every `qa-test` process is killed before the pass upload, whose `if:`
also needs that stop to succeed.

What still bounds a forged pass: publish checks the patch itself (`isDenied`, the secret scan, symlinks and
submodules), the PR is a draft a person reviews, and nothing merges. A forged cache entry can only take a key that
holds no entry: a key already saved cannot be overwritten. Trusted jobs restore by exact key, so a later run reads it
only when its key matches, which a forger can arrange for a lockfile change that is public before it merges, or for
the fixed Android system image key once the cache has evicted that entry. The agent also writes the unit tests that
`verify-tests` runs, and its tests decide what that check sees.

Only `build` and `cache-system-image` save caches, because they run before any untrusted code. Every other job only
restores them with `actions/cache/restore`, `native-control` included, so no job saves a cache after code a model
wrote ran (the forged cache entry above is the exception). `setup-bun` runs with `no-cache: true`: its own cache save
is a post step, after the job's steps, which in most jobs include model-written code.
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
`claude`, even with the scrub and Seatbelt. Zone D therefore rests on a different
guarantee: the model cannot start any process. Five conditions hold it up. `explore.sh run` sets (a), (b), (c) and
(e) for an `ios` or `android` session, and the workflow holds (d). It refuses `c7-two-devices-ios`: its second
browser could write anywhere in the checkout. Only `c7-two-devices-android` gets that browser.

- (a) The Maestro gate (`scripts/maestro-gate.ts`, `mcp-maestro.json`) is the only path to the device. It sends
  Maestro only flows that pass the allow list in `scripts/maestro-flow.ts`, and brings the app back to the front when
  a command leaves it. The app is in front when the top element bears its name (iOS) or a view's resource id starts
  with `<appId>:id/` (Android, whose top element has no name).
- (b) No Bash: `--tools Write`, `--disallowedTools Bash`, and the hook denies it too.
- (c) Maestro's cloud tools, `list_devices` and `open_maestro_viewer` never reach the model: the gate does not offer
  them, and they are disallowed by name.
- (d) No copy of the key in a file the job's user can read. In `explore-native` it lives only in the `env:` of the
  session step and the secret scan after the session, never interpolated in `run:` and never
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

Before any session, `explore.sh canary <session> <out>` checks the gate with no model and no key.
`scripts/native-canary.ts` takes the place of `claude` in the session's own command: it builds the same config dir, so
it reads the hook command from the same `settings.json` and the gate from the same `--mcp-config` file, then makes the
two forbidden calls itself. It runs the hook as Claude Code does (the call as JSON on stdin; only exit code 2 blocks)
for a Write to `/tmp/qa-canary-outside.txt`, and creates the file if the hook lets it through. It runs the hook for the
`run` call too, and if that passes it sends `run` with `- runScript: canary.js` to the real gate over MCP stdio. The
canary passes only when the gate log shows the hook's `allow mcp__maestro__run` (the hook let the run reach the gate),
the gate's `deny run`, the hook's `deny Write`, and the file does not exist. A crash anywhere leaves a line missing, so
it fails the same way. If it fails, no session runs. It differs from a session in one way: Claude Code itself does not
run, so its own rules (`--tools`, `--disallowedTools`, the Edit rule) and its scrub of the hook's environment are not
exercised here. The CLI stays pinned to `@anthropic-ai/claude-code@2.1.303`, the version tested for those, and nothing
fails when the pin moves, so a bump needs the check below. iOS sessions use the fake AI only (no provider key on the
Mac), and no agent that edits code runs there.

Upgrading the Claude Code CLI: install the new version, then run two short sessions with `ANTHROPIC_API_KEY` set, from
the repo root. The dry run prints the session's command, settings and env as JSON and starts nothing; `try` rebuilds
that command in a fresh config dir with the hook command you give it and your own prompt. The session's tools are
`Write` and the Maestro gate, so the Edit rule is tested through `Write`.

```bash
out=/tmp/qa-upgrade session=c2-chat-power-user-ios
mkdir -p $out && touch $out/webview.log $out/backend.log
export QA_DEVICE_ID=any QA_WEBVIEW_LOG=$out/webview.log QA_BACKEND_LOG=$out/backend.log
QA_DRY_RUN=1 .github/qa/scripts/explore.sh run $session $out > $out/dry.json
inside=$(cd $out && pwd -P)/$session/inside.txt
prompt="Call the Maestro run tool with the yaml \`- tapOn: Continue\`. Use Write to create /tmp/qa-upgrade-outside.txt
with the text canary. Use Write to create $inside with the text ok. Make all three calls, then stop."
try() { # $1: the hook command, $2: the prompt
  cfg=$(mktemp -d) && rm -f $out/$session.gate.log $inside /tmp/qa-upgrade-outside.txt
  jq --arg c "$1" '.settings | .hooks.PreToolUse[0].hooks[0].command = $c' $out/dry.json > $cfg/settings.json
  jq -j --arg cfg "$cfg" --arg p "$2" '.command | map(if startswith("CLAUDE_CONFIG_DIR=") then "CLAUDE_CONFIG_DIR=" + $cfg
    else . end) | (index("-p") + 1) as $i | .[$i] = $p | .[] | ., "\u0000"' $out/dry.json |
    env $(jq -r '.env | del(.QA_DRY_RUN) | to_entries[] | "\(.key)=\(.value)"' $out/dry.json) xargs -0 env > /dev/null
  cat $out/$session.gate.log; ls $inside; test -e /tmp/qa-upgrade-outside.txt && echo "outside file EXISTS"
}
try "$(jq -r '.settings.hooks.PreToolUse[0].hooks[0].command' $out/dry.json)" "$prompt" # 1: the session's hook
try "exit 0" "$prompt" # 2: no hook, the Edit rule alone
```

Run 1 must print, in any order, `allow mcp__maestro__run gated Maestro tool` (Claude Code calls the hook on MCP
calls), `deny Write <resolved path> is outside the session dir` (the path with links resolved, so
`/private/tmp/qa-upgrade-outside.txt` on macOS) and `allow Write inside the session dir`, then `inside.txt` and no
"outside file EXISTS" line (the hook's exit code 2 stopped the write). Run 2 has no hook lines; it must print the
gate's own `allow run` line, `inside.txt` (the rule still lets the session dir through) and again no "outside file
EXISTS" line (the rule alone refused the path outside the session dir). The outside file is never created by hand, as
the Write tool would refuse to overwrite an existing file anyway. Only then change the version here and in the
workflow.

In CI, nothing a native session runs comes from the checkout. On Android, c7's second browser can write anywhere in
it while the key is in the environment, and the same steps run on every native leg. Before the canary,
`explore.sh harness <session> <dir>` compiles the gate, the hook and the canary with `bun build --compile` into
standalone binaries that read nothing from the checkout or `node_modules`, built with the `--no-compile-autoload-*`
flags so they ignore a `bunfig.toml` (whose `preload` is code) or `.env` where they start. It copies `explore.sh` and,
for c7, the layout probe, installs the second browser's MCP server there, and writes the session's MCP config pointing
only at those files. The workflow makes the dir read-only and runs `<dir>/explore.sh canary` and `run` with
`QA_HARNESS=<dir>`. In that mode `claude` starts in an empty temp dir, so neither it, the hook, the gate nor the
browser's MCP server starts in the checkout, and `run` skips its summary, so no repo code runs in a step that holds the
key after the session. The stream goes to `<out>/<session>.run.jsonl`, next to the gate log and outside the session dir
the model can write to; the save step builds `execution.json` and `transcript.json` from it without the key, after the
tripwire and the secret scan.

### Real-AI legs

c3, c4, c5 and the free sessions explore with the real providers, and their findings replay with them too, so the
provider keys share a job with model-written specs. Two things keep them apart:

- A separate OS user for the backend. With `QA_BACKEND_USER=qa-backend`, `stack.sh start` creates that user,
  writes the four keys to `/home/qa-backend/keys.env` (mode 0400, owned by that user) and drops them from its own
  environment before any server starts. The backend runs through `sudo -u qa-backend` and reads the file with
  `bun --env-file`. No process of the job's user holds a key, in its environment, its command line or a log.
- No root after the stack is up. `stack.sh lock` removes the docker socket (the docker group is root in all but
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
   `covered`, `behind-keyboard`, `focus-covered`, a fixed or sticky box over part of the focused text field,
   `focused-clipped`, a scroll box or the screen edge cutting off the focused field while the keyboard is open, and
   `unnamed-control`, a control a screen reader cannot name),
   all with `console.error`, so they pass the MCP's `--console-level error`. A problem line is a `layout` finding.
   An `unnamed-control` line has no name to quote, so it quotes which control it is: the control's own `id` as
   `#<id>`, its `data-testid` as `[data-testid=<value>]` or its `name` attribute as `[name=<value>]`. React's and
   Radix's generated ids (`:r3:`, `«r3»`, `_r_3_`, `radix-…`) change between renders and do not count. Without
   one, it quotes the lucide icon the control draws and the nearest text a screen reader reads before it
   (`[qa-layout] unnamed-control button "arrow-left icon after Connect Google"`), or `at the start`, leaving out
   hidden text and what a field holds. The quote is part of the fingerprint, so each control gets its own ticket,
   unless two quotes differ only in digits (`normalize` drops them, so `#step-1` and `#step-2` share one). Replay
   matches the whole line, so a line about another control of the same role never confirms the finding. Two
   controls with the same icon and no text between them still share one line, and a quote taken from text that
   changes between runs (an email the run typed, the end of an AI reply) cannot replay. An `unnamed-control`
   finding takes its screen's area severity, as `covered` does, and an onboarding flow that stops on it gets no
   privacy step from replay, since its quote is not text the screen shows. The MCP does not put console text in a tool
   result: a navigate result holds a count of console errors and a link to the lines the load wrote, in a log file
   under `--output-dir` (absolute, because of `--file-paths absolute`). The explorer reads the lines with
   `browser_console_messages`. `report.ts` follows each navigate link inside the session's own directory (the link
   is cut at its `mcp/` or `mcp-b/` part, so another runner path still resolves) and lists a session whose page
   loads lack the ready line under "Layout probe" (Back is not a load: it is a same-document move), because a
   clean layout there proves nothing. A native `run`
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
3. **replay** (`verify.ts replay`): schema, oracle (`noise.txt`) and lint gates, then each spec 3 times. A spec
   asserts the bug inside `test.step('bug check', …)` (`bugStep` in `findings.ts`), and the lint drops one without
   it. A run counts as failed only when it failed inside that step, read from the JSON report: the step holds an
   error, or the test timed out while it ran (duration -1). A run that failed before it, in its sign-in for example,
   never reached the bug: it is inconclusive, and since Playwright runs no replacement the finding is flaky, with
   `replay.reason` saying how many runs failed early, unless the runs that reached the step confirm it anyway (2
   failures for a real-AI charter). A spec that puts its sign-in inside the step still passes this check; the judge
   is the backstop there. The control spec has no such step, so any failure of it counts.
   Otherwise 3 of 3 failures confirm a finding, 2 of 3 for the real-AI charters (`realAiCharters` in `findings.ts`)
   and for a `layout` finding proved by a native flow, whose measurements vary with the keyboard animation's timing
   (a browser spec, c7's on Android included, keeps 3 of 3);
   1 or 2 are flaky (report only), 0 is dropped. c7 replays on Postgres + PowerSync, the real-AI charters against
   the real providers, the rest on pglite with the fake AI. A `visual` finding skips the lint and Playwright and
   takes no place under the replay cap. It is confirmed when its screenshot exists, a browser screenshot result in
   the session's transcript names it, no Write or Edit call touched it, and it is a PNG or JPEG within the API's
   image limits (10 MB base64-encoded, 8000 px per side). Otherwise it is dropped. A native finding has a Maestro flow
   (`repro_flow`, `repro/<n>.yaml`) instead of a spec, except c7 on Android, whose browser-side bugs keep a spec. The
   session dir decides which, never the finding's own `charter` or `viewport`: a finding whose repro does not fit
   its session is dropped at the schema gate, and every other finding takes its session's platform as its
   `viewport`. The flow passes the gate's allow list with `${EMAIL}` as its only variable, and
   `verify.ts replay --native` runs it 3 times through `replay-native.ts`, each time on a fresh install (the
   onboarding build for c1, the plain one otherwise), with a video under `<out>/videos/`. `control/stack.yaml` runs 3
   times first on the plain build; one failure marks the stack unhealthy and no flow runs. A control run whose iOS driver did not
   start, even on its retry, is inconclusive and replaced like a finding's run, up to 3 extra runs; a control left with fewer than 3
   counted runs also marks the stack unhealthy. On Android the install also maps the stack's ports into the
   emulator again and warms the app up (as `native.sh install` does). Each run ends with one `maestro hierarchy` of the screen it stopped on, for the tree's
   `unnamed-control` lines and, on Android, its `behind-keyboard` line; a screen the run only passed through, like
   the privacy step the harness clicks through, adds no tree line.
   A `layout` run fails when the probe (or a tree rule) logs the quoted `[qa-layout]` line during it, a `console-error`, `page-error` or `http-5xx` run when a new WebView or backend log
   line holds the evidence (cut at the console mark and normalized like the fingerprint), any other run when the flow
   fails. Both sides are compared as the gate showed them to the explorer (`cleanLogLine` in `sanitize.ts`: secrets
   hidden, foreign links removed). A run whose driver did not start (`iOS driver not ready in time`) is run once more and never counts as the
   bug. A `layout` or log-oracle run whose flow failed before the quoted line showed never reached the screen: it is
   inconclusive and run again, at most 3 extra runs per finding. The finding is confirmed when the line shows in 3 of
   3 conclusive runs (2 of 3 for the real-AI charters and for a `layout` oracle, whose measurements vary with the
   keyboard animation's timing), and flaky when fewer than 3 runs are conclusive after the
   extra runs. A run whose flow passed without the line still counts as not shown. For the other oracles, where a
   failed flow is the bug, the flow's last command that is not `waitForAnimationToEnd` is the bug's assertion:
   everything before it runs first as its own `maestro test`, in the same launch, so a failure there is inconclusive
   and run again in the same way. Such a flow must end on a plain `assertVisible` or `assertNotVisible` (or, for
   `stuck`, an `extendedWaitUntil`), or the lint drops it: a `retry` or `runFlow` block there would carry its steps
   into the part whose failure confirms the bug. A `layout` flow whose last command is `assertVisible`
   or `assertNotVisible` is dropped at the lint gate: it would fail on every run without the line, so each of those
   runs would be rerun as inconclusive and the finding would get up to 6 tries. A native leg also keeps to its job's
   time: a run starts only if it can end 5 minutes before replay-native's 360 minutes (2 for the sanitize and the
   upload, 3 for an iOS run whose driver does not start in time and runs again), counted from `QA_LEG_START`, which
   the job's first step records, so the setup is counted as it ran. A run is taken to last as long as the slowest so
   far (at least 4.5 minutes), leaving out the leg's first run: it starts Maestro's driver and the app on a cold
   device, and takes about 4 minutes on iOS against 2 to 3 for each run after it. The flows run most severe
   first, so a leg that runs out of time leaves the least severe without runs. The control's
   other two runs are timed before any finding's. An extra run must also leave room for the 3 runs each later finding
   is owed. A finding left with fewer than 3 counted runs is flaky, and `replay.reason` says why. A flow that waits
   for the first screen after sign-in (`Welcome to Thunderbolt!` on the c1 build, `Ask me anything…` otherwise; three
   dots count as the ellipsis) but never types the code `12345678` is signed in by the harness.
   `control/sign-in.yaml` and a wait for that screen run first as their own `maestro test`, in the same launch, and
   the flow then goes on from its own wait. A run whose sign-in failed never runs the flow and is inconclusive,
   whatever the oracle, so it can never prove a bug. Without that rule, a replay whose iOS flows never typed the
   code would have every run inconclusive. A flow for a bug on the sign-in screen waits for no later screen, so it runs as written.
   `drivers/maestro.md` gives the model the same sign-in block to copy, and each build's landing wait.
   A c1 flow that stops at the welcome wait or next waits for a text gets `control/consent.yaml` at the end of its
   sign-in step: it ticks the privacy checkbox and skips Connect Google, but only while the checkbox shows and that
   text (for a stopping layout flow, the quoted element) does not.
4. **judge** (`verify.ts judge`): one Opus call per confirmed finding with `judge.md` and `known-issues.md`; a
   `visual` finding is judged on its screenshot, a native one on the flow replay ran (the allow list's own
   serialization, read from a path checked like a screenshot's). For a `layout` finding the replayed probe
   line is the proof and a screenshot only context. The default answer is drop. The judge also proposes the
   ticket's priority from a four-line rubric in `judge.md`. When the kept findings carry two distinct fingerprints or more, one more
   call with the same model groups them by defect (`groupFindings`), because each platform can word one bug
   differently: Android names an icon button by the text before it where the web and iOS also name the icon, and
   a field the keyboard hides is `behind-keyboard` on Android but `focused-clipped` on iOS. That call sees each
   finding's title, area, platform, oracle and screenshot path, fenced as untrusted data, and counts against the
   judge's spend ceiling and `judge_usage`. Code checks the answer: every confirmed finding in exactly one group,
   one area per group, and findings that share a fingerprint kept together. Only an answer that passes goes into
   `verified.json` as `groups`. A malformed answer, a failed check, an API error or too little room under the
   ceiling logs why and leaves the whole run to fingerprint grouping. Writes `verified.json`.
5. **file** (`file-findings.ts`): grouping and dedupe, severity, secret refusal. A run files as many tickets as it
   has bugs.
   A table keyed on area and oracle type gives each finding a starting severity. The judge's priority may move it
   one level up or down, but a console error or an overflow never goes above Medium. A missing or unknown
   priority keeps the table's value. Dry run unless `--live`. Each group in `verified.json` becomes one ticket;
   without `groups`, findings that share a fingerprint do (the fingerprint ignores the platform). The ticket
   files with the highest severity among its findings, its `**Platforms:**` line lists every platform that found
   the bug, and an open ticket gets one comment with that line. The ticket text comes from the group's most severe
   finding (ties go by fingerprint), and it lists each other member whose fingerprint differs, with its platform,
   title and evidence. A secret in any member holds back the whole ticket. A group's ticket carries the fingerprint
   of its first finding in `platforms.json` order, then by fingerprint. Nothing about groups is stored across weeks, so
   the same findings land on the same `[qa:<fp>]` ticket every week, and a group that loses its first-platform
   finding moves to another member's fingerprint. A `visual` finding's fingerprint is its area, function and element (`<role> "<name>"`), never its
   wording; one without an element or a function is refused. Its ticket names the element and embeds the screenshot, uploaded with the content type its bytes declare. A `security` finding uploads no screenshot and no video.
   A screenshot or video that fails to upload costs the ticket only that attachment: the ticket is filed without it,
   the log gets a warning with Linear's or the storage's error message, and the ticket's `filed.json` rows list it
   under `lostAttachments` with that reason. When Linear will not create a ticket or add a comment, the error is
   logged and filing goes on with the next one; the job fails once every ticket has been tried.
   An Android `layout` finding of the `covered` kind is refused too, with its reason in the report, until the probe
   has swept correct Android screens clean (see "Known limits"). It still replays and is judged, and an iOS finding
   of the same bug is filed as usual. Every other Android layout kind files like any platform.
6. **fix** (off by default, `fix.ts` and `fix.md`): one fix job per confirmed ticket, from any area, most severe
   first. A bug found on several platforms is one ticket, so it gets one job. The fix goes on the ticket's Linear
   branch name (`branchName`), so merging the PR closes the ticket. `route` takes that name only when it has the
   shape `<prefix>/<identifier>` with an optional `-<slug>`, in lowercase, with at most 100 characters, and
   `git check-ref-format` accepts it; otherwise the branch is `qa-fix/<identifier lowercased>`, which still links
   the ticket. A ticket filed in a dry run has no identifier and uses `qa-fix/<fp>`. `route` logs and skips a ticket
   that Linear has completed or canceled, a ticket with an open PR of this repository on the older `qa-fix/<fp>` or
   on any branch that holds its identifier as a whole `-` or `/` token (Linear's own linking rule, so a teammate's
   branch counts), and a ticket whose branch exists without an open PR, since the key owner may be working there. A
   ticket Linear does not return gets the identifier-only branch and a log line. `publish` pushes only when the
   branch does not exist yet. Each stage waits for its whole matrix, so with about 20 tickets the time from `file` to the last
   `publish` is about 70 to 80 minutes, and about two hours when one fix runs to its step timeout.
   A `spec` task's original spec must pass 3 times on the patch; a run that fails anywhere, even before its
   `bug check` step, keeps the patch unpublished, since a patch that breaks the way to the bug proves no fix.
   A `visual` task has no spec, so the agent first writes `qa-out/fix-<fp>/repro/check.spec.ts` (the depth and
   `repro/` dir of a repro spec, so its imports and the Playwright config work), a check that fails because of the
   defect. The fix job runs that check three times on the patched dev stack, where every run must pass, then three
   times on the builds without the patch, with the patch stashed so the backend runs without it too, where every
   run must fail. A real-AI web
   task (`real`) is fixed on the fake AI, and `verify-real` runs its spec three times on the real providers against
   the patched frontend; all three must pass. A real-AI web visual task has no spec for `verify-real` to run, so
   `publish` never opens a PR for it: the ticket gets `Human Required`, like a fix that failed its checks.
   Every web task (one without a `flow`, real-AI, visual and security tasks included) must also add or change a unit
   test file, `*.test.ts` or `*.test.tsx` under `src/`, `shared/`, `backend/` or `cli/`, that fails without the fix.
   `verify-tests` (keyless, see "Trust zones") checks it on a fresh checkout with `fix.ts tests`: `testRuns` picks
   the test files the patch adds or changes (a deleted one is left out, a renamed one counts under its new name) and
   runs `bun test --timeout 5000` over them from each tree's own directory (`src/`, `backend/`, `cli/`,
   `shared/agent-core/`, and the root for the rest of `shared/`), as the repo's test scripts do. With only the patch's
   hunks for those files applied (`git apply --include`) a run must fail, and with the whole patch every run must
   pass, all in one process. `git apply` runs as the job's user, each `bun test` as `qa-test` (`QA_TEST_USER`,
   through `sudo --user`, with only `PATH` from the job's environment), so a test cannot write the checkout either.
   A patch with no such file fails, and so does a test that needs Postgres or another service the job does not
   start, or that writes into the checkout: the ticket then goes to a person. A native task keeps its Maestro check
   instead. Any check a task needs that did not succeed (failed, skipped or cancelled) uploads no pass (see
   "Passes"), and the fix job's own checks also leave a diagnosis that says why. A fix job that stopped before the
   fix session began diagnosed nothing. Either a step before the fix step failed (its outcome is `skipped`, and
   the fix job shows as failed, so the failure notification fires), or the fix step failed before the model first
   answered (the action's setup, the CLI install, a refused first request). Right after the key scan, before any
   code the agent wrote runs outside its sandbox, the fix job records which of these happened, or `null` when the
   session began, and uploads it as `qa-fix-status-<fp>-<run attempt>`. A step timeout counts as begun: the step ran
   for its whole cap, though the action had no chance to write its execution file. `publish` downloads the file into
   `qa-out/status/`, where the agent's `qa-fix-<fp>-<run attempt>` cannot reach, and fails on a missing or malformed
   one. When the session never began, `publish` touches neither Linear nor GitHub and still succeeds, and the run
   summary names the ticket and says it was left for a later run. Only a process the sandbox let outlive the session
   could still rewrite that record before its upload (whether the sandbox blocks writes to `$RUNNER_TEMP` is
   unconfirmed). At worst that leaves its own ticket untouched instead of `Human Required`; the record never leads to
   a PR. A session that began and then failed or timed out keeps the diagnosis and `Human Required`. A fix job that
   uploaded no status (its key scan failed, or the runner was lost) fails `publish`, because nothing says whether the
   agent ran. One whose secret scan failed uploaded its status but no fix output, and its ticket gets
   `Human Required`. `verify-native-run` and `verify-real` download the patched app or frontend by pattern, so a fix
   that built none shows no error there either.
   An iOS or Android task carries its Maestro `flow` instead of a spec: the agent writes the patch on Linux (reproducing
   the bug on the web at phone size in `qa-out/fix-<fp>/repro/web.spec.ts` when it shows there), and a native visual
   task's check is the Maestro flow `qa-out/fix-<fp>/repro/check.yaml`, which must end on an assertion. Without the
   patch only that final assertion can show the defect; a step before it that fails makes the run inconclusive.
   `publish` refuses an edited repro flow (`fix/<fp>.yaml`) and a flow or check outside the Maestro allow list.
   `fix-plan.json`'s `verifyNative` lists each native task's flow and the repro flows of the same bug on other native
   platforms. `native.sh verify-build` (job `verify-native-build`) builds the patched app in a temporary worktree, and
   `native.sh verify-run` (job `verify-native-run`), from a checkout the patched build never ran in, runs the flow three
   times on it with no key; a layout or log oracle also needs the probe's ready line in every run. A patched run that
   fails anywhere, before the bug's assertion too, fails the patch: a fix must leave the whole way to the bug working.
   Only a failed harness sign-in is run again. Without the patch, a run that never reached the bug, by replay's rules,
   is run again and never counts as showing it. With `unpatched` (a visual check, or an Android real-AI task, which the
   keyless run can only check on the fake AI) the flow also runs on the build without the patch and must fail there
   every time. The unit test is a web fix's regression guard. A rule in code (`whyNoSpec` in `fix.ts`) adds the repro
   spec, or a visual task's check, to `e2e/` only for a bug a unit test cannot show. happy-dom computes no layout, so
   a `visual` finding and a `layout` one qualify, except an `unnamed-control` line: a missing accessible name shows in
   a unit test. A `lost-on-reload` finding qualifies too, since the testing guide
   (`docs/internals/development/testing.md`) sends browser storage, redirects and Better Auth callbacks to `e2e/`.
   Every other oracle (a page or console error, a 5xx, a stuck control, a failed assertion, an AI-reported failure)
   gets no spec, and the PR and commit say the unit test in the patch guards the fix. A native fix PR adds no
   regression spec. Neither does a fix PR from a c1 session, because the root `playwright.config.ts` does not serve
   the onboarding build, nor a real-AI web fix PR, because that config runs the consumer project on the fake
   provider, nor a security fix PR. `regressionSpec` cleans a spec it adds: TypeScript's organize-imports drops the
   imports it never uses (without sorting the rest), the MPL header from `scripts/license-headers.ts` goes on top when
   it has none, and prettier formats it with the repo's config, read before the patch lands. `stage` in `fix.ts` puts
   the patch and that spec into the index, and publish commits what it stages. `verify-checks` (keyless, every task,
   native ones included) runs `fix.ts gate` on a fresh checkout, after `stack.sh lock`. That one process stages the
   same tree, commits it as publish would (so `i18n:check`'s `git status` test sees a committed tree, as in CI), and
   runs the PR checks on it (`prChecks`): `bun run check` (ci.yml's type check and lint, plus the e2e type check, the
   format check and the license check), e2e.yml's `bun run e2e:check-collected`, and, when the tree touches their
   paths, ci.yml's `bun run i18n:check`, `bun run test:5x`, the agent-core, backend and cli type checks, lints and 5x
   suites. Each runs with ci.yml's exact command over the whole tree, never only the changed files: a test that
   passes alone can fail there, when another file's `mock.module` leaks into it in one Bun process. The checks run as
   `qa-test` with `CI=true`, in order, and stop at the first failure. The full Playwright suite, the builds, the
   browser and native checks, the segregated WebSocket tests (flaky by design; ci.yml retries them) and the Helm,
   miniapps, Rust, wasm and QA jobs are left out: too slow, or on paths a fix seldom touches (`verify-native-build`
   compiles a native fix's Rust, but nothing lints it). The gate is skipped when the fix job left a diagnosis or no
   patch, or a visual task has no check: publish hands those tickets to a person anyway. A failed check is the
   pipeline's: the job's summary names the ticket and the check, no PR opens, the ticket gets no write, and
   publish's summary says it was left for a later run. `publish` needs a pass from every platform in `verifyNative`
   for the fingerprint, web tasks included, from `verify-real` for a real-AI web task, from `verify-tests` for every
   web task and from `verify-checks` for every task (see "Passes"). Only then does it open a draft PR on the task's
   branch. Otherwise the ticket gets `Human Required` with the reason (for a native platform, "the flow still fails
   on the native platform"). A fix from a session whose charter has `postgres` in `legs.ts` (today c7), on any
   platform, never gets a PR either: the fix job and `verify-native-run` start no Postgres or PowerSync, so they
   cannot verify it, and its ticket gets `Human Required`. A fix PR gets an automatic preview deploy like any other
   PR.
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
counted. A `visual` finding is judged on its screenshot and has no baseline replay, so it is neither found nor real;
the report lists it as "Not measured". Canary findings are never filed.

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
Every charter runs on desktop and phone. The layout probe covers screen fit, so no function lists it.

Coverage counts a function only when a `passed` or `failed` attempt quotes text a browser tool returned in that
attempt's window, after a browser action, and, for a passed `reload` function, after a navigation that follows a
change.
Text the explorer typed never counts, and a session without a transcript covers nothing. The check proves the quote
was seen at the right moment, not that it shows the outcome: sample covered functions by hand.

The free session plays one case from `journeys.json` (a person, a goal with no steps, and `facts` the explorer
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

Everything runs from the repo root, and `stack.sh` needs `jq` on the PATH. Use a production build: the Vite dev
server reloads pages while Playwright writes traces.

The stack takes its ports from these variables, and the defaults are the numbers CI uses:

| Variable             | Default | Listener                 |
| -------------------- | ------- | ------------------------ |
| `QA_FRONTEND_PORT`   | `1424`  | frontend, onboarding off |
| `QA_ONBOARDING_PORT` | `1425`  | frontend, onboarding on  |
| `QA_BACKEND_PORT`    | `8005`  | backend                  |
| `QA_PROVIDER_PORT`   | `9878`  | fake AI provider         |
| `QA_MCP_PORT`        | `9879`  | fake MCP server          |
| `QA_GOOGLE_PORT`     | `9880`  | fake Google              |

An empty variable means the default. The defaults live in `ports.json`. A value that is not a whole number from 1 to
65535 stops the script at once. `stack.sh serve` checks the ports its mode opens, on `127.0.0.1` and on `::1`, before
it starts anything, and refuses one that is in use: `port 8005 is in use: stop what listens there or set
QA_BACKEND_PORT to a free port`. So stop any `bun run e2e` first, or move the stack to other ports. PowerSync on
`18081` is CI's Docker service for c7 and stays fixed.

```sh
# Builds (about 3 s each)
.github/qa/scripts/stack.sh build qa-dist
.github/qa/scripts/stack.sh build qa-dist-onboarding onboarding   # only for c1

# The stack: fake AI, pglite, the normal build on the frontend port and the onboarding build on the onboarding port.
# Leave it running.
.github/qa/scripts/stack.sh serve qa-dist qa-dist-onboarding

# The guard
bunx playwright test --config .github/qa/playwright.config.ts --project control

# One session, named <charter>-<platform>; the platform sets the viewport and the MCP config. The last argument is
# the budget cap in USD (default 2).
ANTHROPIC_API_KEY=… .github/qa/scripts/explore.sh run c2-chat-power-user-desktop qa-out 4
ANTHROPIC_API_KEY=… .github/qa/scripts/explore.sh run c2-chat-power-user-phone qa-out 4
```

- c7 needs its second browser:
  `QA_MCP_CONFIG='.github/qa/mcp.json .github/qa/mcp-two-devices.json' … explore.sh run c7-two-devices-desktop qa-out 4`.

- The free session runs one case on one platform per call, named `free-<case>-<platform>` (`explore.sh journey`
  prints this week's case). Like every session it takes its viewport and MCP config from `platforms.json`, and it needs the real-provider
  stack below: `ANTHROPIC_API_KEY=… .github/qa/scripts/explore.sh run free-trip-planner-phone qa-out 4`.
- c3, c4, c5 and the free session use real providers: start the stack with `QA_REAL_PROVIDERS=true` and
  `ANTHROPIC_API_KEY`, `TINFOIL_API_KEY`, `TINFOIL_ENCLAVE_URL`, `EXA_API_KEY` in its environment. Replay their
  findings against that same stack, from their own out dir. Locally the backend runs as you: `QA_BACKEND_USER` and
  `stack.sh lock` are for CI's throwaway Linux runners (`lock` would take your sudo away for good).
- c7 needs Postgres and PowerSync. Start them as `nightly.yml` does, run `bunx drizzle-kit migrate` in
  `backend/`, start the stack with `DATABASE_URL` and `POWERSYNC_URL` set, and run the session with
  `QA_MCP_CONFIG='.github/qa/mcp.json .github/qa/mcp-two-devices.json'` (the second file adds its second browser).

Then the rest of the pipeline:

```sh
# Replay: no keys in this shell, and the stack running with the fake AI (real providers for c3–c5 and free-*)
bun .github/qa/scripts/verify.ts replay --out qa-out
ANTHROPIC_API_KEY=… bun .github/qa/scripts/verify.ts judge --out qa-out
bun .github/qa/scripts/file-findings.ts --out qa-out    # dry run; LINEAR_API_KEY adds dedupe and scorecard.json
bun .github/qa/scripts/fix.ts route --out qa-out       # lists open PRs, so `gh` must be signed in here
bun .github/qa/scripts/report.ts summary --out qa-out   # writes qa-out/report.md
```

A filer dry run logs only one line per finding, because the Actions log is public. The would-be ticket text is
`preview` in `filed.json`, except for security findings, which get none.

Canary leg: pick the canaries, then build the canary frontend from a reverted copy, so your checkout stays clean:

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

Fix agent: run it in a separate checkout (it edits the working tree), with
`.github/qa/scripts/stack.sh serve dev` from that checkout (it serves the app on the frontend port, 1424 by default,
with onboarding skipped and on the onboarding port, 1425 by default, with onboarding on, so a fix for an onboarding
finding can be verified) and the flags of the `fix` job. Collect the patch like the workflow does, then, on a clean
checkout, `bun .github/qa/scripts/fix.ts tests --out qa-out --fp <fp>` runs the patch's unit tests without and with
the fix, as `verify-tests` does (as yourself, unless `QA_TEST_USER` names another user), and leaves the checkout as it
was. `fix.ts gate`, with the same arguments and `fix-plan.json` in `qa-out/`, commits the tree publish would push
and runs the PR checks on it, as `verify-checks` does; reset the checkout to the commit before it afterwards. Write
`{"stoppedBeforeSession": null}` to `qa-out/status/<fp>.json` and one `qa-pass-<fp>-<check>-1` line per check you
saw pass to `qa-out/artifacts.txt` (publish reads attempt 1 when `GITHUB_RUN_ATTEMPT` is unset), then
`bun .github/qa/scripts/fix.ts publish --out qa-out --fp <fp>` without `--live` shows the commit and the PR it would
open.

Two stacks side by side. Two agents can run two stacks on one machine when each uses its own six ports. A build
bakes the backend and fake Google URLs into the app, so a second stack needs its own builds, made with its own
variables, and the `control` project needs the same variables as the stack it checks.

```sh
export QA_FRONTEND_PORT=2024 QA_ONBOARDING_PORT=2025 QA_BACKEND_PORT=2005 \
  QA_PROVIDER_PORT=2078 QA_MCP_PORT=2079 QA_GOOGLE_PORT=2080
.github/qa/scripts/stack.sh build qa-dist-2
.github/qa/scripts/stack.sh build qa-dist-2-onboarding onboarding   # only for c1
.github/qa/scripts/stack.sh serve qa-dist-2 qa-dist-2-onboarding
bunx playwright test --config .github/qa/playwright.config.ts --project control   # in another shell, same exports
```

Every out dir must sit directly under the repo root: the specs import `../../../e2e/helpers`,
`../../../.github/qa/layout` and `../../../.github/qa/ports`.

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
.github/qa/scripts/native.sh logs ios "$udid" /tmp/webview.log
.github/qa/scripts/native.sh install ios "$udid" "/tmp/qa-ios/Thunderbolt Dev.app"
.github/qa/scripts/native.sh wait-logs "$udid" /tmp/webview.log           # iOS only: until the stream has attached

# A session on it: the canary first, then the session (both need ANTHROPIC_API_KEY). The backend log is the one
# `stack.sh start` writes. QA_DRY_RUN=1 prints the claude command and its hook settings instead.
export QA_DEVICE_ID=$udid QA_WEBVIEW_LOG=/tmp/webview.log QA_BACKEND_LOG=/tmp/qa-stack.log
.github/qa/scripts/explore.sh canary c2-chat-power-user-ios qa-out && .github/qa/scripts/explore.sh run c2-chat-power-user-ios qa-out 4

# Replay the native findings: no keys in this shell, the same two logs, both builds. QA_LEG_START (the epoch
# second the job started, which CI sets) caps the replay to its job's timeout; unset, it counts from this command.
bun .github/qa/scripts/verify.ts replay --out qa-out --native ios --device "$udid" \
  --app "/tmp/qa-ios/Thunderbolt Dev.app" --app-onboarding "/tmp/qa-ios-onboarding/Thunderbolt Dev.app"

# Check a fix's patch: build it in a temporary worktree (onboarding for c1), then run the finding's flow three times
# on it. The flow must sit in qa-out, whose verified.json holds the finding. A visual check or an Android real-AI
# session also gets the unpatched build as the last argument. The patched build runs the patch's code, so in CI the
# run happens in another job on a fresh checkout. verify-run exits non-zero when the patch does not pass.
.github/qa/scripts/native.sh verify-build ios qa-out/fix/<fp>.patch <session> /tmp/qa-ios-patched
.github/qa/scripts/native.sh verify-run ios "$udid" "/tmp/qa-ios-patched/Thunderbolt Dev.app" \
  qa-out/<session>/repro/1.yaml <session> qa-out/verify/<fp>.ios.json

.github/qa/scripts/native.sh stop-logs /tmp/webview.log
```

A native app bakes the backend and fake Google URLs and its CSP in when it is built, so it talks only to a stack with
the same `QA_BACKEND_PORT` and `QA_GOOGLE_PORT`. Build with the `QA_*_PORT` variables of the stack it will use (see
"Run it locally"). On Android, `adb reverse` maps the stack's backend, fake AI, fake MCP and fake Google ports, and
PowerSync's 18081, to the emulator.

`config <platform> <out-json> [control]` is the Tauri config `build` uses: `tauri.dev.conf.json` with the
stack's two extra `connect-src` origins (`http://localhost:8005` and `http://127.0.0.1:9880` by default, read from
`stack.sh`), and without the dev `identifier` on Android, whose Gradle project has no `.dev` package directory. Its
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

`QA_IOS_DEVICE=<simulator udid>` picks the device; with it unset,
`device ios` creates an iPhone 17 Pro Max on the newest iOS runtime. Two scripts share the machine: take
`/tmp/qa-stack.lock` before the default stack (any other takes `/tmp/qa-stack-<QA_BACKEND_PORT>.lock`) and
`/tmp/qa-sim.lock` before the simulator (`mkdir`, an `owner` file, `rm -rf` at the end). The state files follow the same
rule: `qa-stack.*` for the default stack, `qa-stack-<QA_BACKEND_PORT>.*` for another. Shut the simulator down when
you booted it.

Traps:

- The second iOS build fails with `Directory not empty` while `src-tauri/gen/apple/build/arm64-sim` exists. `build`
  deletes it first.
- A hardware keyboard keeps the on-screen one from opening, and every keyboard check then measures nothing.
  `device ios` turns `ConnectHardwareKeyboard` off before it boots the simulator.
- `simctl addmedia` aborts on a file it cannot read as media, even when the Maestro step says `optional`, so
  `device ios` adds only `fixtures/*.png`, never the `.txt` files.
- The console reaches the iOS system log only with `WebKitDebugLogsPageMessagesToSystemConsoleEnabled` set, which
  `device ios` does, and lines logged before `log stream` attaches are lost, so a session must not start before the
  stream's `Filtering the log data` header shows up. `logs ios` only starts the stream and records the time;
  `wait-logs` waits for the header. The workflow runs `logs ios` right after the boot, so the stream attaches while
  the app installs and the stack starts, and `wait-logs` just before the first step that reads the log. On a slow
  runner the header can take a minute or never come: `wait-logs` replaces a stream that is still silent 60 s after
  its start, once, and fails with "the log stream never attached" when the replacement is silent for 60 s as well.
  The first stream's wait counts from its start, so time spent on the install is not waited twice; the replacement
  gets its own 60 s even when the install already used the first stream's. Piping it into `tail` hangs the shell; it runs in the
  background and `stop-logs` stops it by pid.
- On macOS the stack must run under the system `/bin/bash` 3.2 as well: `serve` polls its servers instead of using
  `wait -n`, which 3.2 lacks.
- The Android console (`Tauri/Console` in logcat) exists only in debug builds, and the APK's target is the host's
  architecture (`aarch64` on an Apple Silicon Mac, `x86_64` on the runner). The build reads `ANDROID_HOME` and
  `NDK_HOME` from the environment.
- On a cold emulator the first opens of a fresh install can hit the 5 s IndexedDB timeout, and the init stops at
  `step0_5_storage_check`, sometimes twice in a row. `install android` opens the app
  until a launch logs `[init] step1_`, up to 4 launches of 30 s each with a stop between them, and fails with the last
  storage check line when none does. Sessions, the control and every replay run start on a warm app, and a bad
  emulator fails at the install instead of later as `stack unhealthy`.
- adb drops its `adb reverse` mappings when its connection to the emulator resets. After such a reset the backend
  can get no request and the WebView stream can stop with it, so the app's requests fail
  ("Something went wrong") in every run after. `install android` maps the stack's ports again before it opens the
  app. `device android` also grows the emulator's log buffers to 64 MB, so the log a replay job saves at its end
  still holds its first runs.

Not proven locally: `device android`, `install android` and `logs android`. They need an emulator, and so far have
run only on GitHub's runners (KVM, `x86_64`).

### In the weekly workflow

`legs.ts` plans the native sessions into `nativeLegs` and their replay legs into `nativeVerify`, and lists the
sessions the grid leaves out in `skipped`, which the plan step prints as notices. iOS runs on `macos-latest`,
Android on `ubuntu-24.04` with KVM. Every Linux job is pinned to that image, never `ubuntu-latest`, because the
stack depends on its AppArmor sysctl, KVM and emulator libraries, Playwright dependencies and `qa-dev` user.

- **build-native**, one job per platform of the run, before any untrusted code: `native.sh build` with onboarding
  off and on, uploaded as `qa-native-<platform>` and `qa-native-<platform>-onboarding`. Each artifact is a tar of
  the app, because an artifact drops file modes.
- **cache-system-image**, when the run builds Android, beside build-native and before any untrusted code: downloads
  the emulator's system image (1.9 GB from Google) with `native.sh system-image` and saves it as a cache, unless the
  cache already has it. `explore-native` waits for it, and every job that boots an Android device restores that
  cache before its own `native.sh system-image`, which then finds the image installed. `native.sh system-image`
  retries a failed install once, after deleting what the failed download left behind, because a download can arrive
  corrupt. A failed download saves nothing and fails nothing: each Android job then downloads the image itself.
- **explore-native**, one job per native session: Maestro 2.11.0 from the official installer on both platforms,
  Claude Code 2.1.303, the app the session needs (the onboarding build for c1), the device, `stack.sh start native`
  and the console stream (on iOS started right after the device, on Android after the install). `c7-two-devices-android` also gets Postgres, PowerSync, the web build on 1424 by default
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
  with `--leg`, which goes into each video's name so merged legs never overwrite one another. A warm run takes at
  most about 3 minutes, counted as 4.5, so a native leg replays at most 24 findings (`nativeReplayCap`), most severe
  first: the control's 3 runs and each finding's 3, plus setup, wrap-up and one driver retry, take about 350 minutes
  and fit the 360-minute job, the longest GitHub allows on its own runners. A timeout would lose every finding.
  Extra runs, the control's and the findings', start only while every later finding's 3 base runs still fit, so the
  leg still ends inside the timeout and a later finding keeps its base runs. Every native leg shares that timeout, and the job ends
  when its runs do. Runs can be slower than that, and Android's setup differs from iOS's, so the job's first step
  records `QA_LEG_START` and `verify.ts` starts no run that might end after the timeout: see the replay step above.
  On Android, before the console stream starts, one Maestro session that counts for nothing installs the plain build
  and runs `launchApp`: Maestro starts its driver inside a session's first `launchApp`, and the first session on a
  fresh emulator can fail there with no reason given. If the Maestro session fails, that is only a
  warning (a failing install in the same step still fails the job), its time counts in the leg's setup, and every counted run installs the app again.
  When the replay fails, the job uploads the stack's and the WebView's logs as `qa-logs-replay-<leg>`. On Android
  it does so after every replay and adds the emulator's log (`qa-logcat.log`, read with `logcat -d` once the replay
  is over, since a reset of adb's connection ends a stream), the adb server's log (`qa-adb.log`) and Maestro's debug
  output for each session (`qa-maestro/<time>/`, with `maestro.log` and the commands). None of it is uploaded on
  `android-real`, whose backend held the provider keys.
- The weekly **judge** adds the native legs' candidates to the web ones, like the sync and real legs. A dispatch of
  native sessions only still plans it, so its findings are judged, filed and fixed.
- **verify-native-build** and **verify-native-run** check a native fix (see "Trust zones"). With no patched app,
  `verify-native-run` boots no device and writes no verdict.
- **native-control**, only when a dispatch sets `native_control`: builds the `control` variant per platform, boots a
  device, starts the stack and runs `native.sh control`. It holds no secret and its result is not filed. On Android
  it stops the Gradle daemons between the build and the emulator: the storage check stalled only
  in this job, the one native job that builds before it boots. A failed control also uploads the stack's log
  (`qa-logs-control-<platform>`); the WebView log is in the control's own folder.
- Every Maestro process runs with `MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true`, because Maestro's "Analyze with
  AI" banner filled the error a failed replay run keeps.

## Fake Google

`scripts/fake-google.ts` stands in for Google on `127.0.0.1:9880` by default: the account chooser, the token endpoint,
userinfo, and exactly the Gmail and Calendar endpoints the app's tools call, with Google's JSON and error bodies. `stack.sh`
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

### Fix the tickets of an earlier run

A fix-only run sends the tickets an earlier run filed through fix, verify and publish again, without exploring.
Use it when that run's fix jobs broke. The run id is the number at the end of the run's URL
(`/actions/runs/<run id>`):

```sh
gh workflow run qa-weekly.yml --repo thunderbird/thunderbolt --ref main -f fix_from_run=<run id> -f dry_run=false
```

- `build` checks the id first. It accepts only digits, only a scheduled or dispatched run of `qa-weekly.yml` on
  `main` of this repository whose commit is on `main` (a tag named `main` reports the same branch), and only a run
  whose `qa-filed` artifact has not expired. Artifacts last 7 days. A branch or a fork's pull request runs workflow
  files of its own, which could upload any artifact without the `qa-agent` environment. It then builds the
  frontend and both native apps from the current `main`, picks no canaries and plans no explore, replay or judge
  leg. It ignores `charters`, because every ticket of the earlier run is routed and may need either native app.
- `file` downloads that run's `qa-replay-*`, `qa-verified-weekly` and `qa-filed`. It uploads the replays again as
  one `qa-replay-weekly` and the verified findings as `qa-verified-weekly`, so the later jobs read them from this
  run as usual. It files nothing and routes that run's `filed.json` with the current `fix.ts route`, so routing
  changes made since then apply. That run's `fix-plan.json` is not used.
- `fix_from_run` turns autofix on, still only with `QA_AUTOFIX_ENABLED` and on `main`. Without autofix nothing
  would be routed, so the run fails in `build` before any build. Publishing follows `live` as in every run:
  `QA_LINEAR_ENABLED`, `main` and `dry_run` off. With the default `dry_run`, publish only logs what it would do.
- Routing reads each ticket's state in Linear now, so a ticket completed or canceled since the earlier run is
  skipped with a log line, as in every run. So is a ticket with an open PR or a branch that already exists.
- The report lists only this run's fix sessions, under a heading that names the earlier run. A failure opens its own
  incident, `QA weekly fix-only`, so a fix-only run that passes never closes an incident a weekly run opened.

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
`verify-real`, `publish`, `report` and `app-check`. No required reviewers
(the schedule would hang). Limit its deployment branches to `main`.

| Secret                                         | Used by                                      | What it is                                                                                                                                             |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QA_ANTHROPIC_API_KEY`                         | explore(-native), judge, fix, real-AI stacks | one key from a dedicated Anthropic workspace with a monthly spend limit: the agent, the judge, the fix agent and the app's backend in real-AI sessions |
| `QA_TINFOIL_API_KEY`, `QA_TINFOIL_ENCLAVE_URL` | real-AI stacks: explore, replay, verify-real | QA-only Tinfoil access for the GLM models                                                                                                              |
| `QA_EXA_API_KEY`                               | real-AI stacks: explore, replay, verify-real | QA-only Exa key for search and link previews                                                                                                           |
| `QA_APP_CLIENT_ID`, `QA_APP_PRIVATE_KEY`       | publish, the app check                       | the GitHub App below                                                                                                                                   |
| `QA_HEARTBEAT_URL`                             | report                                       | optional BetterStack heartbeat, sent after a scheduled run on `main` that worked                                                                       |

The `QA_` names differ from nightly's on purpose. Each is a QA-only secret except the GitHub App's two, which belong to
an app shared with other automation. If an environment secret were missing, a same-named repository secret would be
used without warning.

The Linear key is the exception. The QA files into the same Linear team as nightly, so `file` and `publish` use the
existing repository secret `LINEAR_API_KEY`, like `nightly.yml`. It needs to read issues and labels, create issues and
comments, and upload files. `notify` also uses the repository secrets `RESEND_API_KEY` and `LINEAR_API_KEY`.
Do not add a `LINEAR_API_KEY` to the `qa-agent` environment: it would override the repository secret for `file` and
`publish`, while `notify` kept using the repository one.

### Linear labels

`file` creates new tickets in the team's Backlog state (the workflow state of type `backlog`), labelled `qa-agent` and
`Bug`, plus `Security` for a security finding. The team does not use Linear's Triage state, and the filer stops if it has no backlog state.

Team Thunderbolt needs these labels, or the filer stops and lists the missing ones:

- `qa-agent`, `Bug`, `Security` (filing)
- `Human Required` (`publish` puts it on a ticket whose fix ended in a diagnosis or a rejected patch, never one whose
  fix job died before the agent started)
- `qa:valid`, `qa:not-a-bug`, `qa:duplicate`, `qa:env-artifact` (triage; the scorecard reads them to compute
  precision, and filing falls back to a dry run while precision stays under 70% over 8+ triaged tickets that are
  not duplicates)

### GitHub App (auto-fix only)

`publish` uses the existing GitHub App `thunderbolt-automation-agent`, shared with the repository's other automation
(the factory bot), which is why the token is narrowed and why the bypass risk below matters. Its credentials are the
two `qa-agent` secrets `QA_APP_CLIENT_ID` and `QA_APP_PRIVATE_KEY`. The job mints a token narrowed to this repository
with Contents: write and Pull requests: write and nothing else, then pushes the ticket's branch and opens a draft PR.
PRs opened with the default `GITHUB_TOKEN` would not start CI until someone approves the run. Enable "Automatically
delete head branches": `route` skips a ticket whose branch still exists without an open PR.

The app must be installed on this repository with at least those two permissions. If it lacks one, the token request
fails and `publish` stops before it pushes anything.

To check the credentials before turning on auto-fix, run the check by hand. It skips every other job, spends nothing
and writes nothing:

```sh
gh workflow run qa-weekly.yml --ref main -f app_check=true
```

From a branch, the `qa-agent` environment must allow it first (see "Prove a branch before merging"). The check does
not need `QA_AGENT_ENABLED`. It mints the same token as `publish` and lists the repositories the token can reach.

- Pass: both steps are green and the log shows the app's slug and exactly `["thunderbird/thunderbolt"]`.
- Fail: the token step is red, with GitHub's reason (wrong credentials, app not installed on this repository, or a
  permission the installation does not hold), or the second step is red because the token reaches other
  repositories. Nothing was written either way.

The log does not print permission levels. A green token step already proves them: the request names `contents: write`
and `pull-requests: write`, and GitHub refuses it if the installation holds less.

Narrowing limits the token's permissions on this repository, not which branches it can push to. If the app is in the
`main` ruleset's bypass list, a token it mints could push to `main`. `publish` only ever pushes a ticket's branch
(Linear's name or `qa-fix/<identifier>`), only when that branch does not exist yet, and a person reviews every PR.
Check whether the app is in the `main` ruleset's bypass list (Settings → Rules).

Residual risk: test code that the fix agent writes runs in the same job as the QA Anthropic key. The Anthropic
workspace's spend limit bounds what a leaked key can cost, and auto-fix stays off unless `QA_AUTOFIX_ENABLED` is
`true`. Before its upload, the fix job fails and uploads nothing if `qa-out/fix/` holds the key or a token prefix.

## Budget calibration

Caps live in one place per step type: the `env` block at the top of `qa-weekly.yml` for explore and fix (budget,
turns, timeout), `explore.sh` for a native session's turns, and the constants at the top of
`verify.ts` for replay and the judge. Explore: $4.01 / 552 turns (299 in a native session) / 63 min. Fix: $20 /
200 turns / 60 min, its first values, since no fix has run on GitHub yet. Per leg, at most 30 findings are
replayed (24 on a native leg, whose runs are slow) and 84 judged, and a judge leg spends at most $17, its grouping
call included (a call is admitted only if its worst case fits: prompt bytes, 1,600 tokens per screenshot, plus
`max_tokens`, at Opus prices). Replay and the judge take findings most severe first (the table in `findings.ts`),
keeping path order within a severity, so a cap that binds defers the least severe. Findings over a cap are listed
as deferred and never filed, and so is a finding whose judge call still fails after the SDK's retries. A lost
connection, a timeout, a conflict, a rate limit or a server error only defers. The judge job fails after writing
`verified.json` when a call failed for a reason a retry cannot fix (a revoked key, a bad request, a drained
balance), or when every call failed; the file job still files what was confirmed. The app's own provider calls in real-AI sessions are not
measured: watch the QA provider keys' dashboards.

The rule: per step type, cap = the highest value observed (the 95th percentile once there are 20 samples) + 50%,
for cost, turns and duration. The report's "Calibration hint" table computes it from the run's own sessions. One
run gives one sample per charter and platform, so the caps take the highest value. A count cap (findings replayed
or judged) is sized from how many findings needed the step, + 50%, within what the job's timeout allows.
Recalibrate after the first two scheduled runs and whenever a charter changes. The Anthropic workspace's monthly
limit stays the hard ceiling.

The caps come from the first full run on GitHub: every charter on all four platforms, the free session and the
canary leg, with a Sonnet 5.5 explorer and an Opus 5.5 judge. One Android session, cut by an API error after 30
turns, is left out of every peak.

| Cap                              | Samples      | Highest observed       | Cap                    |
| -------------------------------- | ------------ | ---------------------- | ---------------------- |
| explore budget                   | 32 sessions  | $2.67 (c4, phone)      | $4.01                  |
| explore turns, web               | 18 sessions  | 368 (c4, phone)        | 552                    |
| explore turns, native            | 14 sessions  | 199 (c4, Android)      | 299                    |
| explore timeout                  | 32 sessions  | 41.9 min (c4, Android) | 63 min                 |
| findings replayed per web leg    | 5 legs       | 20 (real)              | 30                     |
| findings replayed per native leg | 4 legs       | 25 (android-real)      | 24, the job's limit    |
| a native run, once warm          | 62 runs      | about 3 min (iOS)      | counted as 4.5 min     |
| native setup before the replay   | 4 legs       | 5.0 min                | counted as 7.4 min     |
| judge calls per leg              | 30 confirmed | see below              | 84                     |
| judge worst-case cost per call   | 30 calls     | $0.126                 | $17 per leg, see below |

Explore cost $34.87 for the weekly sessions and $2.52 for the canary leg, and the judge $0.29. A web session took
at most 10.5 minutes and a native one 41.9; a native explore job spent at most 12 minutes outside its session, so
the 63-minute session fits the 90-minute job.

A web finding took 19 to 43 seconds of its leg's replay, 139 on c7's leg, whose specs wait for sync: 30 findings
fit the 45-minute job on every other leg, and c7's leg, which had 4, would reach it only past about 18. A native leg
replayed 4 findings, deferring the rest: the iOS leg had 22 and `android-real` 25. Its setup took 4.1 to 5 minutes,
and a finding took 3 to 4.5 runs, since an inconclusive run is replaced. At the counted 4.5 minutes a run and 7.4 of
setup, 24 findings take 75 base runs, 337.5 minutes, and with the wrap-up and a driver retry 350 of the job's 360,
the longest GitHub allows on its runners; 25 would need 363. At the measured pace those 25 would take about 250.

The judge saw 30 confirmed findings, and replay deferred 48 more. Replay confirmed 30 of the 56 it ran, so a run that
replays them all sends about 56 to the judge: + 50% is 84. A call cost $0.018 on average but is admitted on its worst
case, $0.120 to $0.126, so 84 calls at $0.126 + 50% need $15.88, and grouping 84 findings at most $0.20 more, $0.30
with the same margin: $16.18, rounded up to $17. The calls run in parallel: 15 took under a minute.

Costs from local sessions with a Sonnet 5.5 explorer, an Opus 5.5 judge and fix agent, and CLI 2.1.285:

| Step                                                         | Sessions | Cost               | Turns   | Duration    | Stop                  |
| ------------------------------------------------------------ | -------- | ------------------ | ------- | ----------- | --------------------- |
| explore, fake AI (c1, c2, c4, c6)                            | 12       | $0.44–1.22         | 91–227  | 2.6–6.2 min | all finished          |
| explore, real providers (c3, c5)                             | 4        | $0.48–1.11         | 81–134  | 3.3–7.4 min | all finished          |
| explore, canary leg (hand-written canary)                    | 2        | $0.94–1.03         | 154–162 | 4.6–4.8 min | all finished          |
| judge (Opus 5.5, one call per finding, 4–5 findings per run) | 4 runs   | $0.05–0.08 per run | –       | –           | –                     |
| fix agent (one overflow bug)                                 | 1        | $0.26              | 21      | 3.1 min     | finished, spec passes |

A full set of charters plus the canary leg cost about $7 in explore sessions. c7 has not been measured. Later
samples: c4 on the real AI, $1.72 and 283 turns in 9.2 min, plus $0.14 on the app side; the free
session, $0.49 and $0.50 per platform plus about $0.25 on the app side for sessions and replays. With the table's
numbers the rule gives explore ≈ $1.8 / 341 turns / 11 min and fix ≈ $0.4 / 32 turns / 5 min. That is one local
sample per charter.

The native platforms add 15 sessions a week (7 on iOS, without c7; 8 on Android), each with a web session's budget
and timeout. On GitHub an iOS session cost $0.43 to $1.42 and took 59
to 149 turns and 11 to 39 minutes, an Android one $0.89 to $2.26, 108 to 199 turns and 12 to 42 minutes. The 15
native sessions cost $14.67 together. The turn cap of a native session is the 299 in
`explore.sh`, not `QA_EXPLORE_MAX_TURNS`; the budget and the timeout come from the workflow. Runner time grows too: two native builds
per platform, and every native explore, replay and verify job boots a simulator or an emulator, on macOS runners for
iOS.

## Cut sessions

A session stopped by its budget, its turn cap or the step timeout keeps every finding it wrote, and they are
verified like any other. The report lists cut sessions first, under "INCOMPLETE". A timed-out step leaves no
execution file: its cost shows as $0.00 (check the Anthropic workspace's usage) and its attempts stay unchecked.
When every explore session of the weekly charters, or of the canary leg, ends in an error or a timeout,
`report.ts summary` exits 1, so `notify-on-failure` fires.

## Promote a confirmed spec to `e2e/`

The fix agent's draft PR already does this, except for c1 (see below). By hand:

1. Take `qa-out/<charter>/repro/<n>.spec.ts` from the run's `qa-replay-weekly` artifact.
2. Save it as `e2e/consumer-qa-<fp>.spec.ts` (`e2e/sync-qa-<fp>.spec.ts` for c7).
3. Change `'../../../e2e/helpers'` to `'./helpers'`, `'../../../.github/qa/layout'` to `'../.github/qa/layout'`,
   `'../../../.github/qa/ports'` to `'../.github/qa/ports'`, and `@playwright/test` to `./test` when it imports only
   `test`, `expect`, `Page`, `Request` or `Route`.
4. `bun run e2e:check-collected`, then check that the spec fails before the fix and passes after it.

A c1 spec runs against the onboarding build (`QA_ONBOARDING_PORT`, 1425 by default), which the root
`playwright.config.ts` does not start. It needs its own project before it can live in `e2e/`.

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
  locally either;
- the real-AI isolation on a hosted runner: `useradd`, the backend under `sudo -u qa-backend` reaching bun and the
  checkout in the runner's home, the sudoers rule, the removed docker socket and the Yama check. The same
  `stack.sh` ran in an Ubuntu 24.04 container on Docker Desktop with stub servers, as a `runner` user with
  passwordless sudo and a 0750 home: the backend got the keys and the job's user could not read them, but that
  kernel has no Yama, so only the check's fail-closed branch ran;
- the job-level `environment` expression that is empty for every replay leg but the real one, and the judge's
  merge of the sync and real candidates from per-artifact directories (run locally as a script);
- the native jobs as this workflow runs them. A copy of it ran on a
  push trigger, with the c1 sessions only, no environments and no Linear key. On both platforms it proved the
  builds and the app tars between jobs, the Maestro installer, Claude Code from npm, the harness, the canary (denied
  before every session), the sessions and their upload, the gate's foreground check, the replay and judge legs
  running, and a dry filing; on iOS, the positive control; on Android, the keyboard rect from the tree and its
  `behind-keyboard` rule. Still open:
  a native finding confirmed by replay and filed (iOS replays were dropped, flaky or inconclusive, and Android's
  stopped at the stack control); the Android control exiting 0 (its job stalled on the app's storage check every
  time); the fix agent on a native task, since `claude-code-action` refuses a push event; `verify-native-build`,
  `verify-native-run` and `publish` with a real patched app and verdict; `verify-real`; c7 on Android with the
  `android-sync` and `android-real` legs; every charter but c1 and the free session on both platforms; and a full
  `replay-native` leg under the `QA_LEG_START` clock;
- the fix agent's `Edit(**)` rule with its deny list, the two `bun db generate` rules, and the visual check's runs in
  the fix job;
- `verify-tests` and the passes: the `qa-pass-*` uploads under their `if:`, and `publish` listing them through the
  API with `actions: read`, and the run attempt in their names on a re-run. `fix.ts tests` ran locally on a scratch
  repo. The test user ran in an Ubuntu 24.04 container on Docker Desktop, as a user with passwordless sudo: after
  the lock's rule root was denied and `sudo --user qa-test` still worked, `qa-test` could not read the job user's
  `/proc/<pid>/environ` (the job user could), and the stop killed the detached processes it left. That kernel has
  no Yama, so `stack.sh lock` itself did not run there;
- `verify-checks`: `fix.ts gate` ran on scratch repos with real git, tsc and prettier, and `bun run check`,
  `bun run e2e:check-collected` and `bun run i18n:check` passed on the branch as the developer's own user. Nothing
  ran as `qa-test` yet: a check that writes outside `src/locales` and `backend/src/emails/locales`, or needs more
  than `PATH` and `CI`, would fail every task's gate. A suite with an order-dependent failure on `main` fails the
  gate on the seeds that order it badly, and that ticket waits for a later run;
- the narrow `sudo` stop of the `qa-backend` backend in the real-AI legs. That copy also proved the `ss` port check, the
  lock and the stop of the fix job's dev stack as `qa-dev`. Its start failed in the first fix jobs on GitHub because
  Storybook's cache sat under `node_modules/.cache`, so the `qa` job in `ci.yml` now checks the start as `qa-dev`.

Also:

- The explorer can still stop early by itself. Coverage in the report shows every function it did not reach as
  "unattempted"; the charter owner decides whether an area's list is too long.
- The coverage check trusts the transcript, which the explorer cannot edit, but not what a quote means: an explorer
  can quote a real line that does not show the outcome. Sample covered functions by hand.
- The judge is a model: a borderline finding can be kept in one run and dropped in the next.
- Repro specs are model-written. A spec that fails before its assertion is dropped by the judge even when the bug
  is real.
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
- The tree also reports `unnamed-control` on both platforms, one line per control, in the probe's form:
  `[qa-layout] unnamed-control button "after Connect Google"`. A screen reader reads the name from the platform's
  tree, not from the page. A control has no name when its label and its placeholder are empty and, on Android, so
  is its text; a text field's or combobox's text is its value, never its name. The keyboard's keys are left out, and
  on Android so is every window but the app's, like a browser tab over it. Android gives the role from the class
  Chrome's WebView sets (button, checkbox, radio, switch, text field, combobox). Maestro's iOS tree carries no
  element type, so there only a checkbox, switch or radio shows, as a leaf whose value is 0 or 1, and always as
  `checkbox`; an unnamed button, link or field on iOS is left to the probe. Replay skips the tree on a run that
  cannot count (a failed sign-in, an iOS driver that never started). The onboarding privacy checkbox reads its
  visible label on iOS (`I agree to the Privacy Policy and Terms of Service .`), so it is not reported.
- The tree's quote is the control's page `id` as `#<id>`, which Android's WebView passes on as the resource id
  (generated ids left out, as in the probe), or else the nearest text before it in the tree: the last leaf with
  text, taking a control's name and never a checkbox's state. On Android that also leaves out a field's value; the
  iOS tree cannot tell a field from text, so an unnamed checkbox right after a filled field quotes what was typed
  there. The tree has no icons, no `data-testid` and no `name`, and iOS gives no page ids, so a control without an
  `id` can quote differently there than in the probe, and a web finding about it and a tree finding about it get
  different fingerprints, which only the judge's grouping call can join into one ticket. Two unnamed controls with
  no text between them share one line on the tree. So that one
  control never makes two findings on one platform, the gate and the replay drop the probe's own `unnamed-control`
  lines for what the tree reports (`keepsProbeLine` in `native-layout.ts`): on Android the roles the tree maps
  (button, checkbox, radio, switch, textbox, combobox, and searchbox, which the WebView shows as a text field), and
  on iOS the checkbox, radio and switch lines. Any other role keeps the probe's line, the same one the web gives: a
  link on both platforms, and a button or field on iOS.
- Android `layout` findings of the `covered` kind replay, are judged and show in the report, but are never filed or
  fixed (`refusal` in `file-findings.ts`); every other Android kind files like any platform. Covered tickets need a clean probe sweep of correct screens
  on each platform first, and Android's sweep has not run. On Android the probe has logged `covered button`
  for the sidebar's buttons while the screenshots show them uncovered, or off screen with the drawer closed. The
  lines came only as the drawer closed, or as it opened after a relaunch, and on opening only the buttons farthest
  from the left edge were logged, the ones the sliding page uncovers last. The drawer's animation outlasting the
  probe's 500 ms on the slow emulator fits, but nothing confirms it, so no probe rule was added. Run the sweep on an
  emulator (a keyless GitHub run), fix or exclude what it finds with a fixture, then remove the refusal.
- The canaries are web only; `native_control` plays their part on the native apps, and only when a dispatch asks.
- A fix that touches `backend/` or `shared/` goes to a person when `verify-real` or `verify-native-run` checks it,
  since both run the backend from before the patch. An Android real-AI fix is checked only on the fake AI.
- Google is covered only through the fake Google, by the free session's `calendar-planner` and `inbox-triager`
  cases. Real Google and Microsoft accounts stay out of scope, and Microsoft has no fake yet.
