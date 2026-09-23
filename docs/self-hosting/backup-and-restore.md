# Backup and Restore

Thunderbolt ships no backup scheduler, no snapshot job, and no built-in restore command. Backing up is your job, and the whole of it is one PostgreSQL database plus the secrets in your configuration.

A meaningful part of each user's data never reaches the server, by design: read [what a backup cannot recover](#what-a-server-backup-does-not-recover) before you rely on any of this.

## What to back up

| Item                       | Where it lives                           | Back it up?                                                                        |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| The application database   | PostgreSQL, database `postgres`          | **Yes.** This is the critical piece.                                               |
| `BETTER_AUTH_SECRET`       | Your configuration or secret store       | **Yes.** Losing it signs every user out; they can sign back in.                    |
| `POWERSYNC_JWT_SECRET`     | Your configuration or secret store       | **Yes.** The API and the sync service must keep sharing one value.                 |
| Model provider keys        | Your configuration or secret store       | Yes, or reissue them at the provider.                                              |
| Identity provider data     | Your own identity provider               | Yes, on its own schedule. See [the identity provider](#the-identity-provider).     |
| Sync bucket storage        | PostgreSQL, database `powersync_storage` | No. It is derived from the application database and rebuilds itself.               |
| Each user's on-device data | The browser, desktop app, or phone       | Not possible from the server. See [below](#what-a-server-backup-does-not-recover). |

Restore into the same version of Thunderbolt or a newer one. The API applies any pending schema migrations when it starts, so a dump from an older release comes forward on its own. (If you set `SKIP_MIGRATIONS=true` because you run migrations separately, run yours after the restore.) There is no downgrade path.

## What the database holds

| Contents                     | Notes                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts and sessions        | Including the link between a Thunderbolt account and the identity your provider authenticated.                                                |
| The synced copy of user data | Chats, messages, settings, tasks, projects, prompts, skills, automations, model and agent configuration.                                      |
| Registered devices           | Which devices are on each account and whether they are trusted or revoked.                                                                    |
| Encryption metadata          | A copy of the account's content key locked separately for each approved device, plus the check value that confirms a recovery key is correct. |
| Waitlist entries             | Only if you run a waitlist: who asked for access and whether they were approved.                                                              |
| Personal access tokens       | Only if you issue them: the tokens used for command-line and programmatic access.                                                             |
| Token usage and cost records | Only when the server supplies model access: what each user spent, for the per-user spending caps.                                             |

Data reaches the database only for users who turn sync on. With sync off, a user's content stays on their device and a server backup contains nothing of theirs but their account.

Back up the **whole** database, not selected tables. Encrypted content, the per-device key copies that open it, and device trust are three parts of one state; restoring them from different points leaves accounts that cannot read their own data.

## What a server backup does NOT recover

None of the following is ever sent to the server, so no server-side backup, snapshot, or replica contains it.

| Not recoverable from the server               | Why                                                                                                                                                         |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File attachments                              | Attached files are kept on the device that added them and are sent to the model only while a reply is being generated. The server never stores the bytes.   |
| Model provider API keys                       | A key a user types into the app stays on that device and is never uploaded.                                                                                 |
| Tool server connections and their credentials | A Model Context Protocol (MCP) server is an external tool source a user connects. Both the address and the token it authenticates with stay on that device. |
| Credentials for user-connected agents         | Also held on the device that added them, never uploaded.                                                                                                    |
| Google and Microsoft connections              | The access tokens stay on the device. Reconnecting is the only way back.                                                                                    |
| End-to-end encryption keys                    | Private keys and the key that decrypts content live on each device and are never uploaded.                                                                  |
| Anything from a user who never turned sync on | Their data has never left their device.                                                                                                                     |

Users can back up most of this themselves. See [what users can back up](#what-users-can-back-up-themselves).

## Back up

Dumps are consistent without stopping anything, so a backup can run against a live deployment.

### Docker Compose

```bash
cd thunderbolt/deploy
docker compose exec -T postgres pg_dump -U postgres -Fc postgres > thunderbolt-$(date +%F).dump
```

Check the file is readable before you trust it:

```bash
docker compose exec -T postgres pg_restore --list < thunderbolt-$(date +%F).dump | head
```

Copying the `pg_data` Docker volume also works, but only while the stack is stopped, and only back into the same PostgreSQL major version.

### Kubernetes

```bash
kubectl exec -n thunderbolt postgres-0 -- \
  pg_dump -U postgres -Fc postgres > thunderbolt-$(date +%F).dump
```

Adjust the user and database name if you changed `postgres.credentials` in your Helm values.

The database lives on a PersistentVolumeClaim named `pg-data-postgres-0`. Volume snapshots of that claim are a reasonable second layer, but they are not a substitute for a dump you have verified. Note that `helm uninstall` leaves the claim in place, while deleting the namespace destroys it.

### Managed PostgreSQL

If you pointed `DATABASE_URL` at a managed service, use that service's own backups and point-in-time recovery. Nothing about Thunderbolt's schema needs special handling.

### The embedded database

If you set `DATABASE_DRIVER=pglite`, there is no PostgreSQL server and `DATABASE_URL` is a directory on disk. Back up that directory with the API stopped. If `DATABASE_URL` is unset or still holds a connection string, PGlite runs in memory and there is nothing on disk to back up. This mode is for evaluation only: sync does not work under it, so nothing syncs to or from user devices in the first place.

## Restore

Restoring replaces live data. Take a fresh dump of the current state first.

A dump carries the database, not the cluster. The `powersync_role` login role and the `powersync` publication the sync service replicates through are created once, by the init script that runs on a brand-new PostgreSQL data directory. Restoring into an instance that never ran it leaves the sync service unable to connect.

### Docker Compose

```bash
cd thunderbolt/deploy
docker compose stop backend powersync
docker compose exec -T postgres pg_restore -U postgres -d postgres --clean --if-exists \
  < thunderbolt-2026-09-23.dump
docker compose start backend powersync
```

### Kubernetes

```bash
kubectl scale -n thunderbolt deploy/backend deploy/powersync --replicas=0
kubectl exec -i -n thunderbolt postgres-0 -- \
  pg_restore -U postgres -d postgres --clean --if-exists < thunderbolt-2026-09-23.dump
kubectl scale -n thunderbolt deploy/backend deploy/powersync --replicas=<your replica count>
```

Stopping the API and the sync service first matters. The sync service streams changes out of the database continuously, and restoring underneath it produces a mix of old and new rows on user devices.

`pg_restore` prints warnings for objects it cannot drop. Those are expected on a database that was created empty and are not a failed restore.

### After a restore

1. Watch the API log for the schema migrations to apply, then for the server to start accepting traffic.
2. Sign in, open the same account in a second window, and confirm a new message appears in both.

If sync does not resume, reset the sync service's bookkeeping database and let it rebuild from the restored data:

```bash
docker compose stop powersync
docker compose exec -T postgres psql -U postgres -c 'DROP DATABASE IF EXISTS powersync_storage'
docker compose exec -T postgres psql -U postgres -c 'CREATE DATABASE powersync_storage OWNER postgres'
docker compose start powersync
```

On Kubernetes the same reset is `kubectl scale -n thunderbolt deploy/powersync --replicas=0`, the two `psql` statements above run through `kubectl exec -n thunderbolt postgres-0 --`, then scale the sync service back up.

The sync service reads the application database again from the beginning and every device downloads a fresh copy. Expect the first sync after this to take longer than usual.

## Rolling back to an older backup is destructive

Devices are kept in step with the server. Rolling back to an earlier backup rolls those devices back too: content created after the backup was taken can disappear from them when they reconnect.

Devices that still hold newer data do not push it back up on their own. To recover it, have the user export their data from that device before it reconnects, then import it afterwards.

Device trust rolls back with everything else: a device revoked after the backup was taken comes back trusted, with its copy of the encryption key, and has to be revoked again. Where the server supplies model access, the per-user spending caps are sums over the usage records, so a rollback discards recent spend and hands every user their allowance back.

## End-to-end encryption and restores

End-to-end encryption is optional and off by default (`E2EE_ENABLED`). When it is on, the server holds only ciphertext for message content, titles, and other user-written fields, plus a copy of the account's content key locked separately for each approved device.

| Situation                                    | What a database restore does                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A device the user still has                  | Keeps working. Its keys are on the device, not in the backup.                                                       |
| A device approved after the backup was taken | Its copy of the key is gone. The user approves it again from a device that already works, or uses the recovery key. |
| Every device lost, recovery key kept         | The user enters the 24-word recovery key and reads their restored data.                                             |
| Every device lost, recovery key lost         | The data is unrecoverable. You hold ciphertext and nothing that opens it.                                           |

There is no administrative override and no key escrow. Neither you nor Thunderbolt can decrypt an account whose keys are gone, which is the point of the feature. Make sure users understand that the recovery key is shown once and is the only backup of their own.

## The identity provider

Thunderbolt accounts reference identities in your identity provider, so its backups belong beside the database ones. If it reissues different identifiers for the same people, they arrive as new, empty accounts.

**The bundled Keycloak keeps nothing.** It runs in development mode with its database inside the container and re-imports its realm every time it starts. Any user you create in its admin console, and any change you make there, is gone as soon as its container or pod is replaced. It exists so sign-in works on first boot, not to hold real accounts.

For anything beyond an evaluation, point Thunderbolt at your own identity provider, or give Keycloak an external database of its own and back that up.

## What users can back up themselves

The only way to capture what never reaches the server is from the device that holds it. Under **Settings → Preferences → Data**:

| Action             | What it covers                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Export My Data** | Chats and messages, settings, tasks, projects, prompts, skills, automations, model and agent configuration, and the provider keys and tool server credentials the user typed. |
| **Import Data**    | Reads an export back in. Anything in the file that shares an ID with existing data replaces it.                                                                               |

Tell users two things about the export file:

- **It is plaintext JSON**, including their API keys. It should be treated like a password and stored accordingly.
- **It does not include attached files**, their encryption keys, or their Google and Microsoft connections. With end-to-end encryption on, importing on a new device still requires approving that device first.

Importing on a device with sync on pushes the restored content to the user's other devices as well, so an old export can overwrite newer content everywhere. The API keys and tool server tokens in the file are the exception: they never leave the device that imported them. The app warns about this before it writes anything, and it warns again if the file was exported by a different account.

## A workable routine

1. Take a dump of the application database on a schedule that matches how much work you can afford to lose, and store it off the deployment machine.
2. Keep `BETTER_AUTH_SECRET`, `POWERSYNC_JWT_SECRET`, and your model provider keys in a secret store, versioned alongside those dumps.
3. Restore a dump into a scratch deployment at least once, so the first time you run the procedure is not during an incident.
4. Tell users that attachments, their own API keys, and their encryption keys are theirs to back up, and point them at the export.
