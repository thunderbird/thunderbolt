# PowerSync local development (Docker)

Self-hosted PowerSync Service stack for local development using Docker Compose.

**Full documentation** (synced tables, adding tables, account/device flows, backend API): [docs/powersync-account-devices.md](../docs/powersync-account-devices.md).

## Prerequisites

- Docker and Docker Compose
- Backend Postgres schema applied to the same Postgres instance (see below)

## Quick start

From this directory:

```bash
docker compose up -d
```

- **PowerSync API**: http://localhost:8080
- **Postgres**: localhost:5433 (user `postgres`, password `postgres`, db `postgres`) — host port 5433 to avoid conflict with local Postgres. Also hosts the `powersync_storage` database used by PowerSync for bucket state.

**Postgres init:** Scripts in `init-db/` run automatically the **first time** the Postgres container starts (empty volume). They create the `powersync_role` user, the `powersync` publication for logical replication, and the `powersync_storage` database for PowerSync bucket storage. If you already have data in `pg_data`, run the SQL in `init-db/01-powersync.sql` manually against Postgres, or start fresh with `docker compose down -v` then `docker compose up -d`.

## Backend configuration

1. **Use this Postgres for the backend** (so PowerSync and the app share one database):

   ```bash
   DATABASE_DRIVER=postgres
   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
   ```

2. **Run migrations** (from repo root): `cd backend && bun db generate && bun db migrate`

3. **PowerSync env vars** in `backend/.env`: see [docs/powersync-account-devices.md](../docs/powersync-account-devices.md) (section 3). The config in `config/config.yaml` uses HS256 with the same secret/kid so backend-issued tokens are accepted.

When you add or change synced tables, update `config/config.yaml` sync rules and backend (see consolidated doc).

## Stopping

```bash
docker compose down
```

Use `docker compose down -v` to remove the Postgres volume.
