# The In-Browser Agent Harness

`shared/agent-core` is a real coding agent that runs inside the browser tab: a Pi `AgentHarness`
(`@earendil-works/pi-agent-core`) with `bash`, `read`, `write`, and `edit` tools over a virtual
filesystem, no server-side execution, and no native process anywhere. It is what the **built-in
agent** runs on when the selected model is one Pi can service.

The seam above it is the ACP adapter interface — `createBuiltInAdapter`
([`src/acp/built-in-adapter.ts`](../../src/acp/built-in-adapter.ts)) returns the same
`AgentAdapter` shape as a remote ACP agent, so the chat layer cannot tell the two apart. That side
is documented in [acp-agents.md](./acp-agents.md); this document covers what sits behind it.

Three things about this subsystem are unusual enough to be worth reading before changing it: it
carries a **security boundary** (the per-thread workspace jail), it needs **repo-wide Vite aliases**
to run Node-shaped dependencies in a browser, and it is a **separate test island** that `bun run test`
does not cover.

## Why it exists

The legacy chat pipeline (`aiFetchStreamingResponse`, [`src/ai/fetch.ts`](../../src/ai/fetch.ts))
runs a step-bounded tool loop (`stopWhen: stepCountIs(maxSteps)`, `fetch.ts:771`) over whatever
tools the app exposes, but it has no filesystem and no shell — so a model cannot work over
intermediate files: write a script, run it, read the output, correct itself. The harness gives the
model that loop without asking the user to install
anything and without shipping their data to a sandbox service: the filesystem is ZenFS over the
origin's OPFS, and the shell is [just-bash](https://www.npmjs.com/package/just-bash), a bash
interpreter implemented in JavaScript.

The model is told exactly what that environment can and cannot do, in
[`shared/agent-core/environment-prompt.ts`](../../shared/agent-core/environment-prompt.ts): the
shell has no network (`curl`/`wget` are absent, web access goes through the app's own tools), and
workspace files are invisible to the user, so final content must be delivered in the chat reply
rather than announced as "saved to a file".

## Assembly

[`buildAppHarness`](../../shared/agent-core/build-app-harness.ts) (`build-app-harness.ts:160`) is
the single entry point. It mounts the ZenFS singleton, carves the calling thread's workspace, binds
the four coding tools to it, resolves the model, seeds prior conversation turns, and returns the
harness. Extra tools — the app's integration and MCP tools, converted from AI-SDK shape by
[`mcp-tools.ts`](../../shared/agent-core/mcp-tools.ts) — are appended and activated alongside the
coding tools.

Everything the harness does over HTTP goes through a `fetch` the caller injects, because the app
cannot call a provider directly from a page — LLM traffic routes through its CORS proxy, or through
the Thunderbolt SSO fetch for managed models. Pi's providers do not all offer that seam, so each of
the three model paths obtains it differently:

| Descriptor kind | Builder                                                                    | How the injected `fetch` gets in                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic`     | [`anthropic-model.ts`](../../shared/agent-core/anthropic-model.ts)         | Builds the `@anthropic-ai/sdk` client with the `fetch` hook and hands it to Pi's public `client?` option, re-implementing Pi's simple→full options bridge because `streamSimple` drops `client` |
| `openai-compat` | [`openai-compat-model.ts`](../../shared/agent-core/openai-compat-model.ts) | No seam exists, so it swaps `globalThis.fetch` for the synchronous window in which Pi constructs the `openai` client, then restores it in a `finally`                                           |
| `confidential`  | [`confidential-model.ts`](../../shared/agent-core/confidential-model.ts)   | Wraps the OpenAI-compatible builder, adding catalog compatibility, attestation normalization, and usage-receipt capture                                                                         |

Both non-obvious builders document the upstream behavior they rely on in their file headers —
notably that Pi's `openai-completions` provider constructs its SDK client before its first `await`,
which is the only reason the global-`fetch` swap is race-free. Re-verify those assumptions when
bumping `@earendil-works/pi-ai` or `openai`; neither will fail to compile if they stop holding.

The `confidential` path additionally attaches a receipt lifecycle to the built harness
(`build-app-harness.ts:205`) so provider receipts are correlated with the terminal assistant message
that owns their usage. Both non-Anthropic builders are imported by the CLI —
`buildOpenAiCompatModel` by [`cli/src/provider-runtime/direct.ts`](../../cli/src/provider-runtime/direct.ts)
and `buildConfidentialModel` by [`cli/src/provider-runtime/tinfoil.ts`](../../cli/src/provider-runtime/tinfoil.ts),
with the receipt lifecycle in
[`cli/src/provider-runtime/usage-receipt.ts`](../../cli/src/provider-runtime/usage-receipt.ts) — so
`shared/agent-core` is shared surface, not app-only code.

Pi's event stream is translated into the AI SDK v5 UI message stream by
[`pi-to-aisdk-stream.ts`](../../shared/agent-core/pi-to-aisdk-stream.ts), which is the in-browser
analogue of the ACP translator in
[`src/acp/translators/acp-to-ai-sdk.ts`](../../src/acp/translators/acp-to-ai-sdk.ts). Its output
stream matches what `createUIMessageStreamResponse` produces — one `data: <json>\n\n` line per chunk
— which is what lets the adapter return it as a plain `Response` body.

## The execution environment

[`BrowserExecutionEnv`](../../shared/agent-core/browser-env/browser-execution-env.ts) implements
Pi's `ExecutionEnv` (filesystem plus shell) over **one** ZenFS mount. Its filesystem methods call
`@zenfs/core/promises` directly; `exec()` runs the command through a fresh just-bash `Bash` bound to
[`ZenBashFileSystem`](../../shared/agent-core/browser-env/zen-bash-fs.ts), an adapter over that same
mount. Sharing the mount is what makes the illusion work: a file Pi writes is immediately visible to
`cat`, and a shell redirect is immediately readable through Pi's filesystem API, with no copy step.

The two halves have opposite error contracts, and each adapter honors the one it faces. Pi requires
that operations never throw, so `BrowserExecutionEnv` encodes every failure into a `Result`.
just-bash expects Node-style throws (it maps them to exit codes internally), so `ZenBashFileSystem`
forwards ZenFS errors unchanged. Neither is defensive wrapping — they are the error-handling layer
each contract mandates.

ZenFS is a process-global singleton, like `node:fs`, so it must be configured exactly once.
[`mount.ts`](../../shared/agent-core/browser-env/mount.ts) owns that: `mountAgentFs()` prefers a
`@zenfs/dom` `WebAccess` mount over the origin's OPFS directory (which persists across reloads) and
falls back to in-memory when OPFS is absent or unusable — private browsing, quota, permission. It
never rejects, and it memoizes its promise (`mount.ts:75`), so the one-per-harness-build call is
idempotent rather than reconfiguring the singleton underneath an env that is already running.

`just-bash`'s `defenseInDepth` option is deliberately **off** (`browser-execution-env.ts:145`). It
exists to contain escapes from just-bash's _sandboxed JS_ surfaces (`js-exec`/QuickJS, python),
neither of which is enabled here, and it breaks the bash interpreter it is meant to protect by
tripping over just-bash's own internal `Proxy` use. The sandbox here is the virtual mount with no
host-process access, not global monkey-patching.

## The workspace jail

This is the part to be careful with. Every thread's tools are rooted at `/workspace/<threadId>` on
the one shared mount, and that directory is simultaneously the isolation boundary between threads.

[`workspaceDirFor`](../../shared/agent-core/build-app-harness.ts) (`build-app-harness.ts:51`)
therefore validates the thread id against `/^[A-Za-z0-9._-]+$/` and rejects `.` and `..`
explicitly. A thread id containing a slash or a `..` segment would **move the boundary**, not just
name a different directory — which is why the check throws loudly instead of sanitizing. App thread
ids are UUID-shaped, so nothing legitimate is rejected.

Inside that boundary, [`resolveInWorkspace`](../../shared/agent-core/browser-env/workspace-jail.ts)
(`workspace-jail.ts:31`) resolves a model-supplied path and throws `path escapes workspace` unless
the result is the workspace root or below it. Both halves of the environment route through it:

- `BrowserExecutionEnv.jailed()` (`browser-execution-env.ts:91`) wraps it for every method that
  touches the mount, so they are jailed by construction rather than by each call site remembering;
  the escape surfaces as a `permission_denied` `FileError` to keep the never-throw contract. The two
  pure path computations, `absolutePath` and `joinPath`, are deliberately exempt — they grant no
  access, and Pi's tools rely on `absolutePath` to compute ancestor paths while traversing.
- `exec()` also validates a caller-supplied `cwd` (`browser-execution-env.ts:121`), and
  `ZenBashFileSystem` jails every path it touches, so `cat /etc/passwd`, `ls /workspace`, and
  `cat /workspace/<otherThread>/secret` all fail with a non-zero exit.

Three details keep that lexical check sound, and each is load-bearing:

1. **Symlink creation is refused outright** (`zen-bash-fs.ts:147`). Validating a link's target at
   creation time is lexical against the link's _current_ directory, so a later `mv` to a shallower
   directory leaves the stored relative target pointing outside the jail. A coding agent has no need
   for `ln -s`, so the escape class is removed rather than policed.
2. **`canonicalPath` re-validates the real path** (`browser-execution-env.ts:315`) after
   `realpath` — the one call that follows symlinks — as defense in depth, so the boundary does not
   rest solely on rule 1.
3. **Temp directories live inside the workspace**, under a `.tmp` subdirectory, so temp files are
   readable by the jailed tools (bash's "full output" file, for instance) and are torn down with the
   workspace instead of accumulating in a shared `/tmp`.

Two things the jail is explicitly _not_: it is not a network boundary, and it is not the reason
built-in tools auto-run. The harness also runs network-capable app, integration, and MCP tools that
are not sandboxed at all; auto-run is a product decision that restores the legacy pipeline's
behavior, and the file header of `built-in-adapter.ts` says so precisely because the OPFS isolation
makes it tempting to assume otherwise.

Lifecycle sits in the adapter: one persistent harness per thread, cached and tagged with a config
signature (`harnessSignature`, `built-in-adapter.ts:526`). A mid-thread model, key, prompt, or
thinking-level switch aborts the old harness and rebuilds from request-body history but **keeps the
workspace**, so the thread's files survive the rebuild. `disconnect` — agent delete, config edit,
sign-out — disposes every cached harness and calls `removeAgentWorkspace` for each, so no thread's
files outlive the adapter.

## Making Node-shaped code run in a browser

The Pi engine and its dependencies are written for Node and Bun. Three mechanisms bridge that, and
all three fail in ways a type-checker cannot see.

**A side-effect import that must stay first.**
[`shared/agent-core/index.ts:14`](../../shared/agent-core/index.ts) imports
`./browser-stubs/install-process.ts` before anything else. Pi's runtime and the Anthropic SDK read
the bare `process` and `global` globals at module scope, and bare globals cannot be aliased. ES
imports are hoisted, so a `globalThis.process = …` assignment in a consumer would run _after_ the
hoisted Pi import had already thrown `ReferenceError: process is not defined`. Doing the assignment
at module scope in a module imported first is the only ordering that works. The same chunk installs
a global `Buffer` via [`ensure-buffer.ts`](../../shared/agent-core/ensure-buffer.ts), called at the
top of `buildAppHarness` before any tool runs.

**Repo-wide Vite aliases.** [`vite.config.ts:151-178`](../../vite.config.ts) maps `module`,
`fs/promises`, `fs`, `crypto` and each `node:` form onto browser stubs in
[`shared/agent-core/browser-stubs/`](../../shared/agent-core/browser-stubs), and `path`/`node:path`
onto the `path-browserify` polyfill. These are `resolve.alias`
entries, so they apply to the **entire frontend build**, not only the harness chunk — any app module
importing `node:fs` silently gets an empty filesystem rather than a build error. The stubs differ in
kind on purpose: `crypto` is a real delegation to Web Crypto (Pi generates session and tool-call ids
at runtime), while `fs`/`fs/promises` present an empty filesystem, because the harness's real I/O
goes through ZenFS and the only `require("node:fs")` on the path is a Bun-guarded branch that never
executes — it just has to resolve to something rolldown can bundle. `module` exists because
just-bash's browser bundle evaluates `createRequire(import.meta.url)` at module scope.

> **Ordering rule:** `fs/promises` must precede `fs` in that alias map. A string alias also matches
> the `fs/promises` subpath, so `fs` listed first swallows it. This is the same class of hazard as
> the `powersync-web-internal` alias documented in [AGENTS.md](../../AGENTS.md) — an internal or
> ordering-sensitive resolver detail that breaks at runtime with no compile error.

**A dedicated lazy chunk.** `fetchViaHarness` (`built-in-adapter.ts:724`) reaches the engine through
an injected loader whose production default is `import('@shared/agent-core')`
(`built-in-adapter.ts:842`) — a dynamic import the file marks as a sanctioned exception to the
[route-splitting rules](../../AGENTS.md): the Pi engine plus `zenfs`, `just-bash`,
`@anthropic-ai/sdk`, and `openai` amount to several megabytes and must not sit on the chat entry
chunk. The `install-process` shim living only in that chunk is part of the same property — it never
touches the entry bundle. Keeping the chunk single and separate is asserted by the browser check
below, which fails unless the build emits exactly one `agent-core-*.js`.

## Tests

`shared/agent-core` is a **test island**. Its unit tests are colocated but sit outside frontend test
discovery, so `bun run test` does not run them:

```bash
bun run test:agent-core         # unit tests
bun run test:agent-core:5x      # the same, 5x stability gate (what CI runs)
bun run test:agent-core:browser # production chunk in real browsers
```

The browser check ([`scripts/agent-core-browser-check.ts`](../../scripts/agent-core-browser-check.ts))
is the one that catches what unit tests structurally cannot: it runs a **production Vite build**,
serves it, and imports the emitted chunk in Chromium and WebKit, driving two conversation turns
through the OpenRouter, Thunderbolt, and confidential paths with injected SSE responses, then
verifying OPFS data survives a reload. Each case runs twice, once with the native iterator helpers
deleted from the prototype before import, standing in for an engine that lacks them — a source or
Bun import of the same code misses that regression. Run it on macOS, as CI does — Playwright's Linux
WebKit build lacks the storage API OPFS needs — and expect it to use a fresh persistent profile per
case, since WebKit's ephemeral contexts reject OPFS.

CI runs both gates in a dedicated `agent-core` job on `macos-latest`, path-gated on
`shared/agent-core/**`, `scripts/agent-core-browser-check.ts`, `vite.config.ts`, `package.json`,
`bun.lock`, and the workflow itself (`.github/workflows/ci.yml`). See
[docs/development/testing.md](../development/testing.md) for how this fits the rest of the suite.

## Upgrading the Pi packages

The `@earendil-works/*` packages are pinned to an exact version in
[`package.json`](../../package.json) and are the only packages exempted from the seven-day install
quarantine in [`bunfig.toml`](../../bunfig.toml) — the quarantine exists to avoid auto-pulling
brand-new floating versions, and an exact pin of an actively released package would otherwise be
blocked by it. The CLI pins the same versions in [`cli/package.json`](../../cli/package.json) and
repeats the exemption in `cli/bunfig.toml`, because Bun reads `bunfig.toml` from the working
directory and an install run from `cli/` never sees the root file.

On a bump, check the things that will not fail to compile:

- the two documented reliances in `openai-compat-model.ts` (synchronous client construction; the
  `openai` SDK reading global `fetch` when given none);
- Pi's `client?` option on `anthropic-messages` and the `buildBaseOptions`/
  `adjustMaxTokensForThinking` exports that `anthropic-model.ts` reuses;
- the four coding tools' `name`, `description`, and parameter schemas, replicated verbatim from Pi
  in [`coding-tools/index.ts`](../../shared/agent-core/coding-tools/index.ts) because the model's
  priors depend on the exact wording;
- the model-catalog aliases in `confidential-model.ts`, which paper over ids Pi's catalog does not
  yet carry;
- `browser-stubs/node-fs.cjs`, whose only reason to exist is a specific `require("node:fs")` inside
  `pi-ai`.

Then run the browser check. A dependency cascade regression — a newly imported Node builtin, a lost
browser condition — shows up there and nowhere else.

## File map

The load-bearing files. `shared/agent-core` holds a few small helpers besides: `ensure-buffer.ts`,
`bound-api-key-auth.ts` (a Pi `ApiKeyAuth` resolver for an app-bound credential),
`client-identity.ts` (the client environment/app-version block disclosed to the system prompt), and
`skills.ts` (ACP skills metadata, shared with the ACP path).

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
| `src/acp/built-in-adapter.ts`              | Adapter seam, harness cache and signature, lazy engine import, teardown              |
| `src/acp/built-in-conversation.ts`         | Request body → seed history plus the current prompt (including attachments)          |
| `scripts/agent-core-browser-check.ts`      | Production-chunk regression check in Chromium and WebKit                             |
