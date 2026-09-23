# The In-Browser Agent Harness

`shared/agent-core` runs a real coding agent inside the browser tab: a Pi `AgentHarness`
(`@earendil-works/pi-agent-core`) with `bash`, `read`, `write`, and `edit` tools over a virtual filesystem. No
server-side execution, no native process. It backs the **built-in agent** whenever the selected model is one Pi
services.

Read before changing anything:

- [The workspace jail](#the-workspace-jail) is a security boundary, not a directory layout.
- [Node-shaped dependencies](#making-node-shaped-code-run-in-a-browser) need repo-wide Vite aliases, and every
  mechanism involved fails with no compile error.
- [Tests](#tests) are a separate island; `bun run test` does not cover them.

The seam above it, `createBuiltInAdapter` ([`src/acp/built-in-adapter.ts`](../../../src/acp/built-in-adapter.ts)),
returns the same `AgentAdapter` shape as a remote ACP agent, so the chat layer cannot tell the two apart
([acp-agents.md](acp-agents.md)).

## Why it exists

The legacy pipeline (`aiFetchStreamingResponse`, [`src/ai/fetch.ts`](../../../src/ai/fetch.ts)) runs a step-bounded tool
loop (`stopWhen: stepCountIs(maxSteps)`, `fetch.ts:771`) with no filesystem and no shell, so a model cannot write a
script, run it, and correct itself. The harness adds one with no install step and no third-party sandbox: ZenFS over
the origin's OPFS, plus [just-bash](https://www.npmjs.com/package/just-bash) for the shell.

[`environment-prompt.ts`](../../../shared/agent-core/environment-prompt.ts) discloses two limits to the model: the shell
has no network (`curl`/`wget` absent; web access goes through the app's tools), and workspace files are invisible to
the user, so final content belongs in the reply.

## Assembly

[`buildAppHarness`](../../../shared/agent-core/build-app-harness.ts) (`build-app-harness.ts:160`) is the single entry
point:

- mounts the ZenFS singleton;
- carves the calling thread's workspace and binds the four coding tools to it;
- resolves the model and seeds prior conversation turns;
- converts the app's integration and MCP tools from AI-SDK shape
  ([`mcp-tools.ts`](../../../shared/agent-core/mcp-tools.ts)) and activates them alongside the coding tools;
- on the `confidential` path, attaches a receipt lifecycle (`build-app-harness.ts:205`) correlating provider receipts
  with the terminal assistant message that owns their usage.

### How each model path gets the injected `fetch`

Every HTTP call uses a caller-injected `fetch`: page-side LLM traffic must route through the CORS proxy, or the
Thunderbolt SSO fetch for managed models. Pi's providers do not all offer that seam.

| Descriptor kind | Builder                                                                       | How the injected `fetch` gets in                                                                                                                                                         |
| --------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`     | [`anthropic-model.ts`](../../../shared/agent-core/anthropic-model.ts)         | Builds the `@anthropic-ai/sdk` client with the `fetch` hook, passed to Pi's public `client?` option; re-implements Pi's simple→full options bridge because `streamSimple` drops `client` |
| `openai-compat` | [`openai-compat-model.ts`](../../../shared/agent-core/openai-compat-model.ts) | No seam, so it swaps `globalThis.fetch` for the synchronous window in which Pi constructs the `openai` client, restoring it in a `finally`                                               |
| `confidential`  | [`confidential-model.ts`](../../../shared/agent-core/confidential-model.ts)   | Wraps the OpenAI-compatible builder with catalog compatibility, attestation normalization, and usage-receipt capture                                                                     |

The global-`fetch` swap is race-free only because Pi's `openai-completions` provider constructs its SDK client before
its first `await`. Both builders record their upstream reliances in their file headers; re-check them on any
`@earendil-works/pi-ai` or `openai` bump ([below](#upgrading-the-pi-packages)).

The CLI imports the same builders, so `shared/agent-core` is shared surface, not app-only code:
`buildOpenAiCompatModel` ([`direct.ts`](../../../cli/src/provider-runtime/direct.ts)), `buildConfidentialModel`
([`tinfoil.ts`](../../../cli/src/provider-runtime/tinfoil.ts)), receipt lifecycle
([`usage-receipt.ts`](../../../cli/src/provider-runtime/usage-receipt.ts)).

### How events reach the chat layer

[`pi-to-aisdk-stream.ts`](../../../shared/agent-core/pi-to-aisdk-stream.ts) translates Pi's event stream into the AI SDK
v5 UI message stream, the in-browser analogue of
[`src/acp/translators/acp-to-ai-sdk.ts`](../../../src/acp/translators/acp-to-ai-sdk.ts). Output matches
`createUIMessageStreamResponse` (one `data: <json>\n\n` line per chunk), so the adapter returns it as a plain
`Response` body.

## The execution environment

[`BrowserExecutionEnv`](../../../shared/agent-core/browser-env/browser-execution-env.ts) implements Pi's `ExecutionEnv`
(filesystem plus shell) over **one** ZenFS mount: filesystem methods call `@zenfs/core/promises`, and `exec()` runs a
fresh just-bash `Bash` bound to [`ZenBashFileSystem`](../../../shared/agent-core/browser-env/zen-bash-fs.ts) over the
same mount. Sharing it removes the copy step: what Pi writes, `cat` sees, and vice versa.

- **Opposite error contracts, honored per adapter.** Pi requires that operations never throw, so
  `BrowserExecutionEnv` encodes failures into a `Result`; just-bash expects Node-style throws (mapped internally to
  exit codes), so `ZenBashFileSystem` forwards ZenFS errors unchanged. Neither is defensive wrapping.
- **The mount is configured once**, because ZenFS is a process-global singleton like `node:fs`.
  [`mount.ts`](../../../shared/agent-core/browser-env/mount.ts)'s `mountAgentFs()` prefers a `@zenfs/dom` `WebAccess`
  mount over the origin's OPFS directory (persists across reloads), falling back to in-memory when OPFS is absent or
  unusable (private browsing, quota, permission). It never rejects and memoizes its promise (`mount.ts:75`), so
  repeat calls cannot reconfigure the singleton under a running env.
- **`defenseInDepth` is deliberately off** (`browser-execution-env.ts:145`). It guards just-bash's _sandboxed JS_
  surfaces (`js-exec`/QuickJS, python), neither enabled here, and breaks the bash interpreter it protects by tripping
  over just-bash's internal `Proxy` use. The sandbox is the virtual mount, which has no host-process access.

## The workspace jail

Every thread's tools are rooted at `/workspace/<threadId>` on the one shared mount, which is also the isolation
boundary between threads. Four checks hold it:

| Check                          | Where                          | What it does                                                                                                        |
| ------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `workspaceDirFor`              | `build-app-harness.ts:51`      | Validates the thread id against `/^[A-Za-z0-9._-]+$/` and rejects `.` and `..` explicitly                           |
| `resolveInWorkspace`           | `workspace-jail.ts:31`         | Resolves a model-supplied path; throws `path escapes workspace` unless the result is the workspace root or below it |
| `BrowserExecutionEnv.jailed()` | `browser-execution-env.ts:91`  | Wraps `resolveInWorkspace` around every method that touches the mount                                               |
| `exec()` cwd check             | `browser-execution-env.ts:121` | Validates a caller-supplied `cwd`; `ZenBashFileSystem` separately jails every path it touches                       |

- A thread id with a slash or `..` segment would **move the boundary**, so
  [`workspaceDirFor`](../../../shared/agent-core/build-app-harness.ts) throws instead of sanitizing. App thread ids are
  UUID-shaped, so nothing legitimate is rejected.
- `jailed()` applies [`resolveInWorkspace`](../../../shared/agent-core/browser-env/workspace-jail.ts) by construction,
  not per call site; an escape surfaces as a `permission_denied` `FileError`, keeping the never-throw contract.
- `absolutePath` and `joinPath` are exempt: pure path computation grants no access, and Pi's tools use `absolutePath`
  for ancestor paths.
- In the shell, `cat /etc/passwd`, `ls /workspace`, and `cat /workspace/<otherThread>/secret` all exit non-zero.

Three details keep the lexical check sound:

1. **Symlink creation is refused outright** (`zen-bash-fs.ts:147`). Validating a target at creation time is lexical
   against the link's _current_ directory, so a later `mv` to a shallower directory leaves the relative target
   outside the jail. A coding agent needs no `ln -s`, so the escape class is removed rather than policed.
2. **`canonicalPath` re-validates the real path** (`browser-execution-env.ts:315`) after `realpath`, the one call that
   follows symlinks, so the boundary does not rest on rule 1 alone.
3. **Temp directories live inside the workspace**, under `.tmp`, so temp files stay readable by the jailed tools
   (bash's "full output" file) and are torn down with it.

**What the jail is not.** Not a network boundary: the harness also runs app, integration, and MCP tools, none of
them sandboxed. Not the reason built-in tools auto-run either; that is a product decision restoring legacy behavior,
recorded in the `built-in-adapter.ts` header.

### Harness lifecycle

One persistent harness per thread, cached in the adapter under a config signature (`harnessSignature`,
`built-in-adapter.ts:526`).

- A mid-thread model, key, prompt, or thinking-level switch aborts the old harness and rebuilds from request-body
  history but **keeps the workspace**.
- `disconnect` (agent delete, config edit, sign-out) disposes every cached harness and calls `removeAgentWorkspace`,
  so no thread's files outlive the adapter.

## Making Node-shaped code run in a browser

The Pi engine and its dependencies target Node and Bun. Three mechanisms bridge that, all failing invisibly to a
type-checker.

### A side-effect import that must stay first

[`shared/agent-core/index.ts:14`](../../../shared/agent-core/index.ts) imports `./browser-stubs/install-process.ts`
before anything else; the same chunk installs a global `Buffer` via
[`ensure-buffer.ts`](../../../shared/agent-core/ensure-buffer.ts), called at the top of `buildAppHarness` before any
tool runs.

Pi's runtime and the Anthropic SDK read the bare `process` and `global` globals at module scope, and bare globals
cannot be aliased. ES imports are hoisted, so a `globalThis.process = …` assignment in a consumer runs _after_ the
hoisted Pi import has already thrown `ReferenceError: process is not defined`.

### Repo-wide Vite aliases

[`vite.config.ts:151-178`](../../../vite.config.ts) maps `module`, `fs/promises`, `fs`, `crypto` and each `node:` form
onto stubs in [`shared/agent-core/browser-stubs/`](../../../shared/agent-core/browser-stubs), and `path`/`node:path` onto
`path-browserify`. As `resolve.alias` entries they apply to the **entire frontend build**: any app module importing
`node:fs` silently gets an empty filesystem rather than a build error.

| Stub                | Why it is what it is                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto`            | Real delegation to Web Crypto; Pi generates session and tool-call ids at runtime                                                                                          |
| `fs`, `fs/promises` | Empty filesystem; real I/O goes through ZenFS, and the only `require("node:fs")` on the path is a Bun-guarded branch that never runs and just has to resolve for rolldown |
| `module`            | just-bash's browser bundle evaluates `createRequire(import.meta.url)` at module scope                                                                                     |

> **Ordering rule:** `fs/promises` must precede `fs` in that alias map. A string alias also matches the `fs/promises`
> subpath, so `fs` listed first swallows it. Same hazard class as the `powersync-web-internal` alias in
> [AGENTS.md](../../../AGENTS.md): an ordering-sensitive resolver detail that breaks at runtime with no compile error.

### A dedicated lazy chunk

`fetchViaHarness` (`built-in-adapter.ts:724`) reaches the engine through an injected loader defaulting to
`import('@shared/agent-core')` (`built-in-adapter.ts:842`), a sanctioned exception to the
[route-splitting rules](../../../AGENTS.md): the Pi engine plus `zenfs`, `just-bash`, `@anthropic-ai/sdk`, and `openai`
are several megabytes and must not sit on the chat entry chunk. The `install-process` shim is confined there too,
and the browser check fails unless the build emits exactly one `agent-core-*.js`.

## Tests

`shared/agent-core` is a **test island**: unit tests are colocated but sit outside frontend test discovery, so
`bun run test` does not run them.

```bash
bun run test:agent-core         # unit tests
bun run test:agent-core:5x      # the same, 5x stability gate (what CI runs)
bun run test:agent-core:browser # production chunk in real browsers
```

The browser check ([`scripts/agent-core-browser-check.ts`](../../../scripts/agent-core-browser-check.ts)) runs a
**production Vite build**, serves it, imports the emitted chunk in Chromium and WebKit, drives two conversation turns
through the OpenRouter, Thunderbolt, and confidential paths with injected SSE responses, then checks that OPFS data
survives a reload.

- Each case runs twice, the second with the native iterator helpers deleted from the prototype before import,
  standing in for an engine that lacks them. A source or Bun import misses that regression.
- Run it on macOS, as CI does: Playwright's Linux WebKit build lacks the storage API OPFS needs.
- Expect a fresh persistent profile per case; WebKit's ephemeral contexts reject OPFS.

CI runs both gates in a dedicated `agent-core` job on `macos-latest`, path-gated on `shared/agent-core/**`,
`scripts/agent-core-browser-check.ts`, `vite.config.ts`, `package.json`, `bun.lock`, and the workflow itself
(`.github/workflows/ci.yml`). See [docs/development/testing.md](../development/testing.md).

## Upgrading the Pi packages

The `@earendil-works/*` packages are pinned exactly in [`package.json`](../../../package.json) and are the only
exemptions to the seven-day install quarantine in [`bunfig.toml`](../../../bunfig.toml), which would otherwise block an
exact pin of an actively released package. [`cli/package.json`](../../../cli/package.json) pins the same versions and
`cli/bunfig.toml` repeats the exemption: Bun reads `bunfig.toml` from the working directory, so an install run from
`cli/` never sees the root file.

On a bump, check what compiles either way:

- the two reliances documented in `openai-compat-model.ts` (synchronous client construction; the `openai` SDK
  reading global `fetch` when given none);
- Pi's `client?` option on `anthropic-messages`, plus the `buildBaseOptions`/`adjustMaxTokensForThinking` exports
  `anthropic-model.ts` reuses;
- the four coding tools' `name`, `description`, and parameter schemas in
  [`coding-tools/index.ts`](../../../shared/agent-core/coding-tools/index.ts), replicated verbatim from Pi because the
  model's priors depend on the exact wording;
- the model-catalog aliases in `confidential-model.ts`, which paper over ids Pi's catalog does not yet carry;
- `browser-stubs/node-fs.cjs`, which exists only for a specific `require("node:fs")` inside `pi-ai`.

Then run the browser check: a dependency cascade regression (a newly imported Node builtin, a lost browser condition)
shows up there and nowhere else.

## File map

| Path                                       | What it holds                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `shared/agent-core/index.ts`               | Public surface; the must-stay-first `install-process` import                         |
| `shared/agent-core/build-app-harness.ts`   | `buildAppHarness`, `workspaceDirFor`, `removeAgentWorkspace`, model descriptors      |
| `shared/agent-core/anthropic-model.ts`     | Anthropic model over an injected `fetch`                                             |
| `shared/agent-core/openai-compat-model.ts` | OpenAI-wire model; the synchronous global-`fetch` swap                               |
| `shared/agent-core/confidential-model.ts`  | Tinfoil/confidential model, attestation normalization, receipt lifecycle             |
| `shared/agent-core/pi-to-aisdk-stream.ts`  | Pi harness events → AI SDK v5 UI message stream                                      |
| `shared/agent-core/seed-history.ts`        | Prior turns → Pi messages (text only; tool calls deliberately dropped)               |
| `shared/agent-core/mcp-tools.ts`           | AI-SDK tools → Pi `AgentTool`s (schema and result bridging)                          |
| `shared/agent-core/environment-prompt.ts`  | The browser-execution constraints disclosed to the model                             |
| `shared/agent-core/coding-tools/`          | `bash`/`read`/`write`/`edit` as plain Pi tools, plus edit application and truncation |
| `shared/agent-core/browser-env/`           | `BrowserExecutionEnv`, ZenFS mount, just-bash adapter, workspace jail                |
| `shared/agent-core/browser-stubs/`         | `process`/`global` install, and the `fs`, `crypto`, `module` shims                   |
| `shared/agent-core/ensure-buffer.ts`       | Global `Buffer` install                                                              |
| `shared/agent-core/bound-api-key-auth.ts`  | Pi `ApiKeyAuth` resolver for an app-bound credential                                 |
| `shared/agent-core/client-identity.ts`     | Client environment/app-version block disclosed to the system prompt                  |
| `shared/agent-core/skills.ts`              | ACP skills metadata, shared with the ACP path                                        |
| `src/acp/built-in-adapter.ts`              | Adapter seam, harness cache and signature, lazy engine import, teardown              |
| `src/acp/built-in-conversation.ts`         | Request body → seed history plus the current prompt (including attachments)          |
| `scripts/agent-core-browser-check.ts`      | Production-chunk regression check in Chromium and WebKit                             |
