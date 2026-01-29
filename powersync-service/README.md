# PowerSync local development (Docker)

Self-hosted PowerSync Service stack for local development using Docker Compose.

## Prerequisites

- Docker and Docker Compose
- Backend Postgres schema applied to the same Postgres instance (see below)

## Quick start

From this directory:

```bash
docker compose up -d
```

- **PowerSync API**: http://localhost:8080
- **Postgres**: localhost:5433 (user `postgres`, password `postgres`, db `postgres`) — host port 5433 to avoid conflict with local Postgres
- **MongoDB**: localhost:27017 (replica set `rs0`)

**Postgres init:** Scripts in `init-db/` run automatically the **first time** the Postgres container starts (empty volume). They create the `powersync_role` user and `powersync` publication for logical replication. If you already have data in `pg_data`, run the SQL in `init-db/01-powersync.sql` manually against Postgres, or start fresh with `docker compose down -v` then `docker compose up -d`.

## Backend configuration

Point the Thunderbolt backend at this instance and use the same JWT secret/kid as in `config/config.yaml`:

1. **Use this Postgres for the backend** (so PowerSync and the app share one database):

   ```bash
   DATABASE_DRIVER=postgres
   DATABASE_URL=postgresql://postgres:postgres@localhost:5433/postgres
   ```

2. **Run migrations** against that Postgres (from repo root):

   ```bash
   cd backend && bun db generate && bun db migrate
   ```

3. **PowerSync env vars** in `backend/.env`:

   ```
   POWERSYNC_URL=http://localhost:8080
   POWERSYNC_JWT_SECRET=powersync-dev-secret-change-in-production
   POWERSYNC_JWT_KID=powersync-dev
   ```

The config in `config/config.yaml` uses HS256 with that same secret (base64) and kid so tokens issued by the backend are accepted by the local PowerSync service.

## Sync rules

Sync rules in `config/config.yaml` mirror the backend PowerSync tables and scope data by `user_id` from the JWT `sub` claim. When you add or change backend tables used by PowerSync, update the `sync_rules.content` section and the backend `VALID_TABLES` in `backend/src/api/powersync.ts`.

## Stopping

```bash
docker compose down
```

Use `docker compose down -v` to remove volumes (Postgres and MongoDB data).
