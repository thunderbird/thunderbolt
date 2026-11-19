# Web execution

When the `playwright-cli` skill is installed, use it for browser snapshots/refs,
console, network, screenshots, traces and isolated named sessions; otherwise drive the
repo's Playwright (`bunx playwright`, existing `playwright*.config.ts`) or the harness's
browser tool. Check `--help` and the configs before commands. Start in private scratch
so CLI artifacts do not leak into product source. Use semantic locators or current
snapshot refs, await the expected UI/network state, and collect both the successful
action and persistence/error assertions.

Reuse `.github/qa/functions.json`, `journeys.json`, `charters/` and `known-issues.md`
for current web scenarios rather than maintaining a competing inventory. Read
`.github/qa/scripts/stack.sh` before use: defaults are a test-mode consumer pair,
fake Anthropic provider/MCP/Google and PGlite. Its privileged CI `lock` mode modifies
permissions and is not a local QA prerequisite. Use the intended Postgres+PowerSync
stack for sync. Read `e2e/helpers.ts` to reuse login/wait patterns, while checking that
its test-only code, onboarding bypass and Tauri-error filters do not hide this run's scope.

Read the selected Playwright config's project/baseURL/env before running a spec.
Existing automation supplies hypotheses and regression coverage; verify the current
running revision on every requested target. Mobile browser emulation counts as web
responsive coverage, not native iOS/Android evidence. At <768px web uses mobile sizing;
Tauri desktop uses `.force-desktop` at every width (verify current CSS/hook code).

Typical bounded session (write artifacts under scratch):

```bash
playwright-cli -s=<run> open http://localhost:<vite-port>
playwright-cli -s=<run> tracing-start
playwright-cli -s=<run> snapshot
# Drive scoped actions using freshly discovered refs, then assert results.
playwright-cli -s=<run> screenshot --filename=<scratch>/web-success.png
playwright-cli -s=<run> console
playwright-cli -s=<run> requests
playwright-cli -s=<run> tracing-stop
```

Root Playwright currently captures screenshots only on failure and traces on retry.
Explicitly save success screenshots/assertions and sanitized request summaries.
A clean test exit with no retained success artifact cannot substantiate a matrix row.
Traces/request dumps can contain auth headers and bodies: keep private, sanitize and
scan before sharing. Never print raw secrets from request inspection.

Provider tests: built-in models can use `e2e/fake-provider.ts` (Anthropic **Messages**,
not OpenAI-compatible); custom OpenAI-compatible endpoints use the bundled Node fake.
`e2e/fake-mcp-server.ts` exposes an echo tool over Streamable HTTP at `127.0.0.1` `/mcp`;
it is not a stdio server and does not implement a complete OAuth service. Start it with
a small scratch Bun launcher importing `createFakeMcpServer(port)`. Read current proxy
SSRF/test-host configuration before using it through the backend; do not disable global
SSRF protections to make a mock reachable. A deliberate local test allowlist may be
available only in `NODE_ENV=test`; report that limitation.

For keys, read `~/.argent/secrets.env` in memory inside a script, fill a secure input,
submit/navigate, then assert without echoing values. Disable action traces around secret
entry if they would retain values; use safe post-submit evidence. In-memory extraction
of the email-matched dev verify URL similarly avoids a code file or transcript.

Routing expectations come from current `src/lib/proxy-fetch.ts` and `src/ai/fetch.ts`:
web provider traffic normally proxies, custom loopback endpoints bypass it. Verify CORS,
mixed content and local-network permission behavior rather than assuming access.
A loopback fake is not a remote-host positive control; use a permitted non-loopback
test endpoint/provider for preference ON/OFF evidence.
