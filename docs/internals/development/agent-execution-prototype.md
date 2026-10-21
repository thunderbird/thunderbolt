# Agent execution prototype

The built-in Thunderbolt agent exposes icon-only location and access menus inside
the chat composer, immediately after the + menu. Changes apply to the next turn
and are disabled during an active turn.
Choices persist per chat in this device's local storage; they do not sync.

- **Local sandbox** retains the existing per-thread OPFS/ZenFS workspace and
  just-bash shell, on desktop, mobile, and web.
- **This computer** appears only in Tauri desktop and opens the native folder
  picker, starting in the previous folder or the home folder. Cancelling leaves
  the current execution choice unchanged. Coding tools use the real
  filesystem and native bash. The folder is a starting directory, not a jail;
  absolute paths and shell commands can access the rest of the computer under
  the app's OS permissions. User files survive runtime changes and teardown.
- **Cloud** is a disabled future option; no remote ACP service is connected yet.
- **Ask for approval**, the default, allows audited read tools automatically.
  Changes, all shell commands, and unclassified integration/MCP/Mini App tools
  require approval. Denial prevents execution. Stop cancels pending approval.
- **Full access**, displayed in red, allows tools to execute without approval.
  Switching back to Ask does not inherit ACP's remembered always-allow grants.

## Run alongside another checkout

```sh
bun install --frozen-lockfile
bun run tauri:dev:agent-execution
```

This uses frontend port **1432**, HMR port **1433** when a separate HMR host is
required, and app identifier `net.thunderbird.thunderbolt.agent-execution`.
The normal app/development identifiers and ports remain available to other work.
Use `bun run dev:agent-execution` for the web preview (computer access is hidden).
The prototype config is opt-in and is not part of release builds.

For an isolated backend, install the `backend/` workspace and configure its
ignored `.env` as usual, then run:

```sh
cd backend
PORT=8012 APP_URL=http://localhost:1432 BETTER_AUTH_URL=http://localhost:8012 \
  CORS_ORIGINS=http://localhost:1432,tauri://localhost,http://tauri.localhost bun run dev
```

Set `VITE_THUNDERBOLT_CLOUD_URL=http://localhost:8012/v1` in the frontend's ignored
`.env` before starting Vite. Existing development DB/PowerSync services can be
used; this feature adds no schema or migrations.

## Architecture and limits

`shared/agent-core/execution-environment.ts` defines the small subset of Pi's
`ExecutionEnv` required by the four coding tools. Every filesystem call goes
through this contract; the tools no longer bypass it with direct ZenFS calls.
`buildAppHarness` accepts an optional execution binding, defaulting to OPFS.

`NativeExecutionEnv` receives an injected IPC transport. Rust's
`src-tauri/src/agent_execution.rs` validates desktop/main-webview access, resolves
host paths, and runs commands. Approvals are enforced at the tool boundary in the
trusted main frontend, not as an OS sandbox or a protection against compromised
application code. Native commands default to 120 seconds, accept up to 3600
seconds, and retain up to 4 MiB per output stream. Reads accept regular files up
to 25 MiB. Unix commands run in their own process group, terminated on Stop,
timeout, and completion. Descendants that deliberately detach from that group
can outlive the command; this is host access, not OS isolation. Output draining
is bounded so detached pipes cannot block Stop. Persistent background servers
are not supported. Windows requires `bash` on PATH and uses `taskkill /T` for cancellation;
the prototype's native tests exercise macOS/Unix.

`src/agent-execution/approval.ts` gates both Pi and legacy tool execution. Unknown
tools ask; discovered MCP tools never inherit trusted built-in read permissions
from a matching name; Mini App actions use this shared
gate instead of showing a second approval prompt. Approval requests queue per
turn and carry the originating chat and its AbortSignal. The existing inline
permission UI shows complete arguments. The adapter rebuilds on location
or working-folder changes. Access-policy changes refresh tools and the prompt
without losing tool history. It refuses unsupported native models
instead of silently falling back to sandbox execution.

## Verification

```sh
bun run type-check
bun test src/agent-execution src/components/agent-execution-controls \
  src/acp/built-in-adapter.test.ts src/chats/chat-instance-permission.test.ts \
  src/components/chat/permission-dialog.test.tsx --timeout 5000
bun run test:agent-core
bun run test:agent-core:browser
cd src-tauri && cargo test --lib agent_execution
```

To exercise the desktop flow, choose a disposable folder, ask the agent to write
a small text file, deny the first request, then allow a subsequent request.
Confirm the file exists only after approval; read it back, switch to Full access,
and confirm another write runs immediately. Stop a long command and verify it
does not perform a delayed write. Return to Local sandbox and confirm the same
relative filename is isolated from the host folder.
