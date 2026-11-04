# Cloud agents: operation and security

The existing Bun API process also owns one Pi Durable runtime. It hosts many agents and conversations; it does not start a worker or VM per agent. Postgres holds execution checkpoints, tool results, approval waits, application records, and encrypted client projections. S3-compatible storage holds encrypted complete artifact snapshots. The React app uses the normal authenticated API, PowerSync, and a dedicated scoped-content codec.

The current tool boundary is instruction skills, selected remote HTTP MCP connections, Exa through the existing backend integration, and in-process artifact tools. Cloud shell access, native project-tree replication, organization ownership, and cross-account artifact sharing are not implemented. An artifact may be explicitly shared with another agent of the same owner. Memory notes use ordinary editable Markdown artifacts.

Agents appear in the existing `/settings/agents` list and creation/detail aside, with Cloud as an execution environment. Models, skills, and MCP definitions come from the ordinary Settings libraries; the agent aside selects them and Save captures their resolved configuration. Cloud authorization is configured alongside the corresponding model or connection, independently of device credentials. MCP definitions remain device-local; another device can explicitly import a cloud connection's definition without importing credentials. Artifacts have their own `/artifacts` page, including artifacts produced in ordinary chats and encrypted saved snapshots. Legacy `/settings/cloud-agents` links redirect to these resource pages.

## Configuration and startup

Run the frontend, one Bun backend, Postgres, the existing PowerSync service, and an S3-compatible object store. PGlite remains useful for API tests but cannot own the cloud execution runtime. Use the normal backend auth, CORS, encryption, model, and PowerSync settings from [`backend/.env.example`](../../.env.example). The cloud-specific variables are:

| Variable                             | Example / default                                        | Purpose                                                                                                |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CLOUD_AGENTS_ENABLED`               | `false`                                                  | Enable cloud APIs and runtime startup.                                                                 |
| `CLOUD_AGENT_RUNTIME_IDENTITY`       | `<serialized ResourceIdentity JSON>`                     | Stable secret runtime recipient identity; required when enabled.                                       |
| `CLOUD_AGENT_EXECUTION_ENABLED`      | `true`                                                   | Permit admission and dispatch; set `false` during restore verification.                                |
| `CLOUD_AGENT_MAX_CONCURRENT`         | `8`                                                      | Global concurrent runs, maximum 128.                                                                   |
| `CLOUD_AGENT_MAX_PER_OWNER`          | `25`                                                     | Maximum saved agents per owner.                                                                        |
| `CLOUD_AGENT_MAX_ARTIFACT_BYTES`     | `5000000`                                                | Maximum encrypted snapshot size in bytes.                                                              |
| `CLOUD_AGENT_MAX_STORAGE_BYTES`      | `100000000`                                              | Maximum committed encrypted artifact bytes per owner, including every historical/conflicting revision. |
| `CLOUD_AGENT_OWNER_DAILY_BUDGET_USD` | `20`                                                     | Per-owner daily run reservation limit.                                                                 |
| `CLOUD_AGENT_OAUTH_CALLBACK_URL`     | `https://api.example.com/v1/cloud-agents/oauth/callback` | Exact registered cloud OAuth callback.                                                                 |
| `CLOUD_AGENT_OAUTH_RETURN_URL`       | `https://app.example.com/settings/connections`           | Fixed application return location.                                                                     |
| `CLOUD_ARTIFACT_BUCKET`              | `<private-bucket-name>`                                  | Required artifact bucket.                                                                              |
| `CLOUD_ARTIFACT_REGION`              | `us-east-1`                                              | S3 signing region.                                                                                     |
| `CLOUD_ARTIFACT_ENDPOINT`            | `https://objects.example.com`                            | Optional compatible-store endpoint; omit for AWS S3.                                                   |
| `CLOUD_ARTIFACT_FORCE_PATH_STYLE`    | `false`                                                  | Set `true` for stores requiring path-style addressing.                                                 |
| `CLOUD_ARTIFACT_ACCESS_KEY_ID`       | `<server-only-access-key>`                               | Optional explicit S3 credential; otherwise use the SDK credential chain.                               |
| `CLOUD_ARTIFACT_SECRET_ACCESS_KEY`   | `<server-only-secret>`                                   | Pair with the explicit access key.                                                                     |

The existing `DATABASE_DRIVER=postgres`, `DATABASE_URL`, `POWERSYNC_URL`, `POWERSYNC_JWT_SECRET`, and `POWERSYNC_JWT_KID` still configure database and synchronization. The existing `TINFOIL_API_KEY` enables the managed model, and `EXA_API_KEY` enables search. They are service credentials, never copied into agent configuration. Custom model connections and MCP connections have separate encrypted cloud credentials. For local browser redirects, the two OAuth URLs may use `http://localhost`; their ports must match the actual backend and frontend listeners.

Generate the runtime identity once with `generateResourceIdentity()` from [`shared/cloud-agent/crypto.ts`](../../../shared/cloud-agent/crypto.ts), store it in secret management, and inject the serialized result at boot. Do not regenerate it on every start, log it, put it into client configuration, or commit it. The configured public recipient is exposed through authenticated capabilities; the private key remains server-only. Back up this identity with the database and object-store recovery material.

Apply generated Drizzle migrations before starting the Postgres deployment. From `backend/`, use `bun db migrate`, then `bun run dev` for local development or the normal compiled server entry point for deployment. From the repository root, use the existing frontend development command. Do not use the clustered backend entry point for cloud execution: a Postgres advisory lock intentionally rejects a second runtime owner. The owner uses one reserved database session and serializes runtime commits; independent API database queries use the ordinary pool.

The new `cloud_agent_projections` table requires the repository's two-stage PowerSync rollout. First deploy the backend schema, migration journal entry, shared table registry, and all three sync-rule configurations, and confirm the PowerSync image is live. Only then deploy the frontend schema and cloud UI. See the [synced-table deployment procedure](../../../docs/internals/architecture/powersync-account-devices.md#pr-flow-for-adding-tables). A single development checkout may contain both stages; that is not permission to reverse the production rollout order.

## Grants and plaintext boundary

A trusted app device creates the owner's stable resource recipient. Its private identity is encrypted under an existing account DEK, with the DEK ID recorded for recovery. Agents and connections each have independent random scope keys; artifacts have independent keys so their access can span agents. The device wraps assigned scope keys to the stable runtime recipient and to the owner recipient. The runtime never receives the account DEK.

Cloud execution and its hosting operator are trusted with plaintext in the explicitly assigned scopes. This is a separate trust boundary from ordinary account data encryption. Cloud configuration, run snapshots, messages, approval arguments, schedule prompts, artifacts, and runtime records use authenticated scoped ciphertext, not the account-wide PowerSync envelope format. Their authenticated context binds owner, resource, key epoch, purpose, and record or recipient. Minimal IDs, relationships, status, timestamps, due times, sizes, and admission accounting remain visible for routing and operation. Account data outside assigned scopes is not unlocked by a cloud grant.

The owner recipient public key is captured inside the device-encrypted agent configuration and immutable resolved run configuration. Runtime-created artifacts wrap their recovery key to that authenticated recipient, not to an unauthenticated public-key column read from the database. Their owner envelope remains valid if the creating agent is later deleted. Owner recovery still requires the owner's private resource identity and its historical account DEK.

Anonymous accounts cannot use cloud APIs or execute scheduled/queued runs. Every browser mutation requires a signed-in session bound to the supplied active trusted app device. A forged device header, unbound session, pending device, revoked device, or relay-only CLI device does not confer write authority. Read endpoints return encrypted records to their authenticated owner. Artifact runtime tools additionally require an active explicit grant to that agent, with separate read and write permission. Account membership alone does not grant an agent access to every artifact or memory note.

## Connection authorization and tool outcomes

MCP OAuth is an independent cloud authorization flow. Save a cloud MCP connection, then authorize it from the UI. Discovery requires a matching issuer, S256 PKCE, and dynamic registration of a public client. Unsupported servers fail rather than borrowing desktop credentials. The server stores the verifier, state, frozen endpoints, client registration, and resource binding encrypted under the connection key; only a state digest and expiry remain visible for callback routing.

The callback is intentionally sessionless and exempt only at its exact app-version-gate path. Exact, single-use state authorizes the pending connection. It redirects only to the configured application URL, with a success/failure flag and no tokens. Token exchange and refresh validate HTTPS endpoints and pinned public DNS, refuse redirects, and bound response size and time. Each connection has one refresh owner under a database lock; credential-version changes do not change the user configuration version. Failed refresh requires fresh authorization.

Every outbound MCP/model request checks its captured live credential binding. A disabled connection, changed configuration, key epoch, or refreshed credential invalidates a stale binding. Permission checks remain live even though a run retains its original instructions and skills. OAuth refresh may therefore stop a long-lived run using an older transport; a later run resolves the new credential.

Remote MCP calls are unsafe to replay by default. SDK automatic retries are disabled. A known MCP `isError` response remains a known result; a lost, malformed, or failed response after an actual `tools/call` dispatch makes the outcome uncertain. The runtime persists that uncertainty and blocks subsequent model dispatch. Investigate the remote system before deliberately starting new work that might repeat the side effect. Pre-dispatch permission or validation failures do not claim that a tool ran.

## Artifacts and offline behavior

Each revision is a complete encrypted file bundle, with a separately encrypted manifest. The server allocates a fresh random object key for every upload attempt and inserts a cleanup reservation before PUT. After upload succeeds, one database transaction publishes the immutable revision mapping and updates the current head only if its expected parent is still current. Concurrent edits preserve both revisions and mark the stale-parent revision as a conflict. Retries cannot replace a committed revision with different ciphertext.

Application append-only publication does not depend on the object provider honoring conditional PUT. The adapter sends `If-None-Match: *` as defense in depth, but some compatible providers ignore it. Clients never choose storage object keys, upload attempts never intentionally reuse keys, and every read verifies length, ciphertext digest, and authenticated payload context. This does not promise provider-enforced WORM storage; configure provider versioning, backups, and retention independently when required.

Committed snapshot bytes share an owner quota, serialized by the existing owner-identity row lock. Historical and conflicting revisions count; exact retries do not count twice. This quota excludes temporary uploads awaiting publication or cleanup and excludes database metadata, so it is not a hard physical bucket-size limit.

Failed uploads and losing retries leave delayed cleanup records. Garbage collection waits at least 24 hours, rechecks published references, and retains work when deletion fails. Historical and conflicting revisions remain referenced and are not garbage-collected. Account deletion enqueues owned object keys in the same transaction that removes metadata and runtime state; remote deletion follows through the cleanup queue.

PowerSync distributes encrypted metadata and payload projections; it does not replicate the object bucket. Devices cache downloaded encrypted artifact content for offline reads. An item never downloaded by that device is not available offline merely because its metadata synced. Offline save/message commands are retained locally and require server acknowledgment before they are accepted for execution; cross-device version conflicts remain explicit. Native project trees and whole browser sandboxes do not sync through this feature.

## Restart, restore, and key rotation limits

Normal restarts reuse the same Postgres state, runtime identity, and object bucket. Persisted approvals and safe recovery checkpoints resume through Pi. The adapter fails closed if its owning database session is lost or a commit outcome cannot be confirmed; it does not silently reconnect and continue writing. Restart only after connectivity and sole ownership are restored. An incompatible stored runtime engine version blocks execution instead of guessing a migration.

For a disaster restore:

1. Stop the backend runtime owner and any other writers.
2. Restore a consistent database backup and the encrypted objects it references, together with the original runtime identity and required account recovery material. Restoring database metadata alone cannot reconstruct missing objects.
3. Start with `CLOUD_AGENT_EXECUTION_ENABLED=false`. API reads and projection repair are available, while new run admission and dispatch remain blocked. Garbage collection still runs and checks live references; finish the object restore before starting the backend.
4. Verify owner recovery, representative historical artifacts, pending approvals, and the expected runtime version. Reconcile uncertain external tool outcomes and the schedule due times in the restored backup.
5. Enable execution and restart deliberately. An older backup may restore an already-executed external operation or schedule occurrence, so backup rollback is not an exactly-once guarantee for the external world.

Scope-key rotation is intentionally unavailable. Ordinary Save rejects a changed epoch or replacement key with `rotation_required`; runtime loading rejects an inconsistent epoch. Do not edit these fields or regenerate the runtime identity to simulate rotation. Runtime ciphertext and private HMAC indexes depend on the original scope key, and the current client has no historical resource-key lookup. A correct future rotation must retain owner recovery of history and either open a new execution namespace or perform an explicit quiesced migration and reindex.

Disabling an agent/connection or revoking an artifact grant stops future authorized access; it is not cryptographic erasure. The runtime, a previously trusted device, or a remote tool may already hold plaintext or keys. Ordinary account-key rollover remains readable through the recorded historical DEK, but rewrapping the same owner private resource identity does not revoke a device that already obtained it. Compromised-device recovery needs a new owner resource identity and new affected scope keys, plus a history/regrant migration; that workflow is not implemented. Until it exists, treat compromise as an operational stop-and-recovery event, not as a completed key rotation.

## Checks

From the repository root, run `bun test shared/cloud-agent src/cloud-agent/keys.test.ts --timeout 5000`. From `backend/`, run `bun test src/cloud-agent src/dal/users.cloud.test.ts --timeout 5000` and `bunx tsc --noEmit`. For the Postgres storage conformance and runtime restart suites, set `CLOUD_AGENT_TEST_DATABASE_URL=postgresql://<test-user>:<test-password>@<test-host>/<isolated-test-database>`; never point this at application data. Run the complete backend suite with the repository's `bun run test:backend` command, and the separate WebSocket suite when needed. The OAuth tests exercise real SDK discovery/exchange logic against injected HTTP responses; they do not authorize a real provider account.
