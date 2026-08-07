# Thunderbolt cloud runner

A **remote execution target for the built-in Thunderbolt agent**, exposed as an ACP WebSocket service with detached (background) turns: a prompt turn keeps running after the client's tab closes, and a reconnecting client replays what it missed. This is the server side of "the agent keeps working when I minimize the app".

The runner is placement, not identity. There is no separate agent for users to pick: the app runs its built-in agent either locally or here, and the runner executes exactly the model and reasoning depth the client sends. It holds no model catalog, no model default, and no provider credentials.

## How it works

- **Sessions belong to the process**, not the connection (`src/session-runtime.ts`). A WebSocket dropping only removes that connection's observer; the in-flight turn keeps running and every `session/update` is journaled with a per-session `seq`. Several connections may observe one session at once (two tabs, two devices) and all of them get live updates.
- **The client picks the model.** `session/new`, `session/resume` and `session/prompt` each carry a run spec — `{ modelId, thinkingLevel }` — in ACP `_meta` (contract and helpers in `shared/acp-types.ts`). A missing or malformed spec is an invalid-params error: the runner has nothing to fall back to. `modelId` is whatever id the backend inference gateway accepts, and the gateway stays the authority on which ids exist — an unknown one fails that turn loudly rather than silently running something else.
  - Changing the spec between turns reopens the harness over the **same disk session log and workspace**, so the conversation's model context survives the switch.
  - Changing it *during* a running turn is refused. A `session/resume` that arrives mid-turn keeps the running turn's spec and applies the client's on its next prompt.
- Reconnecting clients resume their session (`session/resume`, disk-backed via the CLI's session store), then call the ACP extension methods:
  - the replay method re-delivers the latest turn's journaled updates through the new connection, then keeps it live;
  - the await-turn method resolves when the in-flight turn ends, carrying the stop reason of the original `session/prompt`;
  - the delete-session method hard-deletes one session's server-side state when its thread is deleted in the app.
- Auth mirrors the backend's managed-ACP endpoints: the signed Better Auth bearer rides a `thunderbolt.bearer.<base64url>` subprotocol entry and is validated per connection by introspecting `GET /v1/api/auth/get-session` on the backend (`src/auth.ts`). No shared secrets, no database access. Each live connection's bearer is re-introspected on an interval, so a revoked or expired session loses its socket (close code `4001`) instead of surviving until the client hangs up.
- **The runner holds no provider credentials.** Model calls go to the backend's OpenAI-compatible inference gateway (`POST ${BACKEND_URL}/v1/chat/completions`) authenticated with the **session owner's own bearer** — the same token that authenticated the socket (`src/gateway-model.ts`). A session adopts the bearer of whichever connection most recently claimed it, and a running turn pins the bearer it started with, so a reconnect mid-turn cannot swap credentials underneath an in-flight request.
- Tools are confined to a per-user, per-session workspace jail (no bash), so multi-tenant isolation holds inside one container. Cheap per-user caps bound the blast radius of a single account (live sessions, concurrent turns).
- **HTML artifacts** are supported through the same `render_html` tool the in-app harness exposes, so a page the model writes here renders in the chat exactly as one written locally does — see below for what the runner does and does not check.
- Retention and erasure (`src/storage.ts`): idle session runtimes are swept after a TTL while their disk logs survive for resume; disk state untouched for `CLOUD_RUNNER_RETENTION_DAYS` is hard-deleted. On demand, the delete-session method erases one session and `POST /purge` erases everything a user owns (account deletion, called by the backend; idempotent, so a retry on an already-empty user still succeeds). Hard deletion is the point on all three paths — a tombstone would defeat privacy erasure.

## HTML artifacts: static validation only (V1 intermediate design)

The runner registers `render_html` with the same tool name and the same `{ html, title }` input as the in-app harness (contract in `shared/artifacts/render-html-contract.ts`), because the client recognizes an artifact from the ACP tool call alone: the harness translator copies the arguments onto `rawInput` and the result onto `rawOutput`, both journaled, so a client that reconnects days later replays the call and renders the page without the runner storing the HTML anywhere else.

**What the runner checks** (`src/artifact-validation.ts`): the document is tokenized with `htmlparser2`, inline `<script>` bodies are parsed by acorn, inline `<style>` bodies by css-tree, and any external script/stylesheet or module import is rejected because artifacts run fully offline. Failures come back as `{ ok: false, errors }` — phrased for the model to read, fix, and call again — rather than as a thrown tool error. The shared logic lives in `shared/artifacts/static-check.ts` and is the same code the in-app harness runs, so the two cannot drift on which script types count as JS or how an issue is worded.

**What it does not check.** Nothing is executed: no DOM, no iframe, no headless browser, no network. A page whose syntax is valid but whose logic throws still passes here. It is the client that actually renders the artifact, and that is where runtime failures surface — the in-app harness additionally renders into a hidden sandboxed iframe before accepting the page, and the runner cannot. The tool description says exactly this, so the model is not told the page was proven to work.

This is the **V1 intermediate design**, chosen because it is fast (a few milliseconds), needs no extra infrastructure, and catches the class of failure that dominates in practice: syntax errors and CDN references. Two options stay open for later, and neither is foreclosed by anything here — the tool's contract with the client would not change:

- run the page in a **sandboxed headless browser** inside the runner, and report real load errors;
- hand it to an **isolated rendering service** that returns a verdict (and possibly a screenshot), keeping browser attack surface out of the runner process.

## Single instance by design (V1)

Session ownership is **process-local**: the harness, the journal, and the in-flight turn live in the memory of the task that accepted the connection, and the session log lives on a shared EFS volume that only one task may write per session. Consequences to plan around:

- **No horizontal scaling.** Exactly one task serves all traffic (`desiredCount: 1`, with the ECS deployment window set to maximum 100% / minimum-healthy 0% so a rolling deploy never overlaps two tasks on the same volume). A second task would accept connections for sessions it does not own and would race the first on the same session logs.
- **A deployment or restart ends every in-flight turn.** Clients resume their sessions afterwards and re-prompt; the disk session logs survive, the in-memory journals do not (so there is nothing to replay for a turn that was cut short).
- Scaling past one task requires distributed session ownership — a lease per session plus routing connections to the lease holder — not just raising `desiredCount`.

## Configuration (env)

| Variable | Required | Description |
| --- | --- | --- |
| `BACKEND_URL` | yes | Thunderbolt backend origin — bearer introspection *and* the inference gateway (`${BACKEND_URL}/v1`) |
| `CLOUD_RUNNER_DATA_DIR` | no | Session logs + workspaces root (default `/data`; mount durable storage) |
| `CLOUD_RUNNER_IDLE_SESSION_TTL_MS` | no | Dispose a detached, idle session runtime after this long (default `1800000`) |
| `CLOUD_RUNNER_REVALIDATE_INTERVAL_MS` | no | Bearer re-introspection interval per live connection (default `300000`) |
| `CLOUD_RUNNER_MAX_SESSIONS_PER_USER` | no | Live session runtimes per user (default `20`) |
| `CLOUD_RUNNER_MAX_CONCURRENT_TURNS_PER_USER` | no | Concurrently running turns per user (default `3`) |
| `CLOUD_RUNNER_RETENTION_DAYS` | no | Days of inactivity after which a session's log + workspace are hard-deleted (default `30`) |
| `PORT` | no | Listen port (default `8080`) |

There is deliberately no model or thinking-level setting: both arrive per session and per turn in the run spec.

## HTTP surface

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | Load-balancer target health |
| `POST /purge` | `Authorization: Bearer <token>` | Account deletion: hard-deletes every runtime, session log, and workspace of the caller. `204` on success, `401` on a bad bearer |
| `GET /` (upgrade) | bearer subprotocol | The ACP WebSocket wire |

## Run locally

```bash
cd cloud-runner && bun install
BACKEND_URL=http://localhost:8000 bun run dev
```

The backend must be running: it is both the token introspector and the model gateway.

Then point the backend at it with `CLOUD_RUNNER_WS_URL=ws://localhost:8080/`. The backend publishes that URL to clients, which use it as the built-in agent's remote execution target — nothing new appears in the app's agent list.

## Deploy (AWS)

`deploy/cloud-runner/` is a self-contained Pulumi project: a single ECS Fargate task (ARM64) + EFS (`/data`) + ALB behind CloudFront, which terminates `wss://` with the default CloudFront certificate (the runner pings every 25s to clear CloudFront's fixed 10-minute idle cap). The image is built from `deploy/docker/cloud-runner.Dockerfile` and pushed to ECR by `pulumi up`. See "Single instance by design" above before changing the task count.

```bash
cd deploy/cloud-runner && bun install
pulumi config set backendUrl https://<backend-origin>
pulumi up
# → output `wsUrl` is the value for the backend's CLOUD_RUNNER_WS_URL
```

No model credential is deployed with the runner — every model call is billed and authorized through the backend gateway under the end user's own token.

## Tests

```bash
bun run test        # unit + integration (in-process runner against a stub backend
                    # playing both introspector and inference gateway), plus the
                    # shared artifact checker in shared/artifacts/
bun run typecheck
```
