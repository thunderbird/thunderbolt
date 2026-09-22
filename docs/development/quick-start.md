# Quick Start

This walks through running Thunderbolt locally: backend API, PowerSync sync service, and the Vite frontend.

## Prerequisites

After cloning, run **`make doctor`** — it inspects your machine and prints exact install commands for anything missing. The most common needs are:

- **[Bun](https://bun.sh/)** 1.2+
- **Rust toolchain** — for Tauri desktop and mobile builds (install via [rustup](https://rustup.rs/))
- **sccache** — optional; `make setup` installs it when Cargo is available to speed up Rust rebuilds
- **Docker** — PowerSync and PostgreSQL run in containers during local dev

You'll also need at least one AI provider API key — Anthropic, OpenAI, Mistral, Fireworks, or any OpenAI-compatible endpoint (Ollama and llama.cpp are recommended for local inference).

### Linux desktop builds

Tauri needs GTK/WebKit dev libraries. On Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
  build-essential curl wget file pkg-config libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
```

For other distributions, use the upstream
[Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux). `make doctor` checks for these on Linux.

## Bootstrap

1. **Clone and install.**

   ```bash
   git clone https://github.com/thunderbird/thunderbolt.git
   cd thunderbolt
   make setup
   ```

   `make setup` installs frontend and backend dependencies, optionally installs `sccache`, and wires up the Claude Code agent symlinks.

2. **Create `.env` files.**

   ```bash
   cp .env.example .env
   cp backend/.env.example backend/.env
   make doctor
   ```

   `make doctor` generates a `BETTER_AUTH_SECRET` for `backend/.env` automatically if it's empty or still set to the placeholder. Add at least one AI provider key (e.g. `ANTHROPIC_API_KEY`) — see [Configuration](../self-hosting/configuration.md) for the full list. Root `.env` is for the Vite/Tauri frontend; `backend/.env` is for the API server.

3. **Start Postgres + PowerSync.**

   ```bash
   make up
   ```

   This runs `docker compose -f powersync-service/docker-compose.yml up -d`. PowerSync listens on `:8080`, Postgres on `:5433` (the non-default port avoids clashing with a local Postgres). Verify with `make status`.

4. **Run the dev servers.**

   _Browser (recommended):_

   ```bash
   make run
   ```

   Backend starts on `http://localhost:8000`, frontend on `http://localhost:1420`.

   _Desktop (Tauri):_ `make dev-desktop`

   _iOS simulator:_ `make dev-ios` (boot a simulator first: `open -a Simulator`)

   _Android emulator:_ `make dev-android`

   Use the `make dev-*` targets rather than the `bun tauri:dev:*` scripts underneath them. Each one starts the backend and then works around a failure mode: Tauri brings its own Vite, so `make run` alongside `bun tauri:dev:desktop` collides on `:1420`; `tauri ios dev` matches simulators by name and otherwise auto-selects a Wi-Fi-paired iPhone; and `gen/android` is committed for the production identifier, so an Android dev build must re-init it for the `.dev` one or it crashes with `ClassNotFoundException`. [Mobile Setup](./mobile-setup.md) has the details.

5. **Sign in.** Open `http://localhost:1420`, create an account, and send a message. If it works, you're good.

## Common Issues

- **`make up` port conflict** — something is bound to `5433` or `8080`. Stop it or edit `powersync-service/docker-compose.yml`.
- **`make up` fails with a Postgres data-format error** — the Postgres image was bumped to v18, which changed its on-disk layout. If your local volume was created with an older version, run `make nuke` to wipe it and re-init (you'll lose any local DB state).
- **Backend errors with `BETTER_AUTH_SECRET`** — run `make doctor`; it generates one for you. Or set it manually with `openssl rand -base64 32`.
- **`powersyncJwtSecret must be at least 32 characters`** — set `POWERSYNC_JWT_SECRET` in `backend/.env` to match the one baked into `powersync-service/config/config.yaml`.
- **Playwright on Ubuntu 26.04 ARM64** — `make setup` automatically uses Playwright's Ubuntu 24.04 ARM64 browser build until Playwright supports 26.04 directly.
- **Tests behave weirdly** — fake timers are globally installed; see [testing.md](./testing.md).

## Helpful Makefile Targets

| Command                 | What it does                                                                   |
| ----------------------- | ------------------------------------------------------------------------------ |
| `make doctor`           | Verifies your tools + env files. `make doctor-q` only prints issues.           |
| `make run` / `make dev` | Starts backend + frontend. Kills stale processes on `:8000` and `:1420` first. |
| `make up`               | Starts PowerSync and Postgres.                                                 |
| `make down`             | Stops containers, keeps volumes.                                               |
| `make nuke`             | Wipes all container data and rebuilds from scratch.                            |
| `make check`            | Runs type-check, lint, format-check, and the license-header check.             |
| `make test`             | Frontend test suite, then backend.                                             |
| `make format`           | Formats frontend, backend, and Rust.                                           |

`make help` lists the full set.

The license-header step is the part of `make check` a first contribution most often trips on: every source file needs the three-line MPL-2.0 header. `bun run license:fix` adds it to anything missing one, and `scripts/license-headers.ts` knows the comment syntax for `.ts`, `.tsx`, `.js`, `.jsx`, `.cjs`, `.mjs`, `.css`, `.scss`, `.rs`, `.kt`, `.kts`, `.sh`, `.sql`, `.html`, and `.astro`. The pre-commit hook already runs it over staged files, so you normally only see the failure when committing outside the hook.

## Next Steps

- [Configuration Reference](../self-hosting/configuration.md) — every backend env var.
- [Mobile Setup](./mobile-setup.md) — iOS / Android / desktop Tauri dev prerequisites.
- [Architecture](../architecture/) — how the pieces connect.
- [Testing](./testing.md) — how to run each suite, the globally installed fake timers, the `mock.module()` hazard, and the Playwright e2e setup.
- [Composite Primary Keys and Default Data](../architecture/composite-primary-keys-and-default-data.md) and [Multi-Device Sync](../architecture/multi-device-sync.md#adding-a-new-synced-table) — schema rules for synced tables.
- [Self-Hosting](../self-hosting/) — deploy Thunderbolt somewhere real.
