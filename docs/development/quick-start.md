# Quick Start

Running Thunderbolt locally: backend API, PowerSync sync service, Vite frontend.

## Prerequisites

Run **`make doctor`** after cloning: it prints exact install commands for anything missing.

| Need                        | Notes                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [Bun](https://bun.sh/) 1.2+ | Required.                                                                                                           |
| Rust toolchain              | Tauri desktop and mobile builds ([rustup](https://rustup.rs/)).                                                     |
| sccache                     | Optional Rust build cache. `make setup` installs it when Cargo is available.                                        |
| Docker                      | Runs PowerSync and PostgreSQL locally.                                                                              |
| AI provider key             | Anthropic, OpenAI, Mistral, Fireworks, or any OpenAI-compatible endpoint (Ollama or llama.cpp for local inference). |

### Linux desktop builds

Tauri needs GTK/WebKit dev libraries. On Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
  build-essential curl wget file pkg-config libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
```

Other distributions: [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux). `make doctor` checks for these on Linux.

## Bootstrap

1. **Clone and install.**

   ```bash
   git clone https://github.com/thunderbird/thunderbolt.git
   cd thunderbolt
   make setup
   ```

   Installs frontend and backend dependencies, optionally `sccache`, and the Claude Code agent symlinks.

2. **Create `.env` files.**

   ```bash
   cp .env.example .env
   cp backend/.env.example backend/.env
   make doctor
   ```

   `make doctor` generates `BETTER_AUTH_SECRET` if it's empty or still the placeholder. Add at least one provider key (e.g. `ANTHROPIC_API_KEY`); full list in [Configuration](../self-hosting/configuration.md). Root `.env` is the Vite/Tauri frontend, `backend/.env` the API server.

3. **Start Postgres + PowerSync.**

   ```bash
   make up
   ```

   Runs `docker compose -f powersync-service/docker-compose.yml up -d`. PowerSync listens on `:8080`, Postgres on `:5433` (non-default, to avoid a local Postgres). Verify with `make status`.

4. **Run the dev servers.**

   | Target             | Notes                                                                                     |
   | ------------------ | ----------------------------------------------------------------------------------------- |
   | `make run`         | Browser (recommended). Backend `http://localhost:8000`, frontend `http://localhost:1420`. |
   | `make dev-desktop` | Tauri desktop.                                                                            |
   | `make dev-ios`     | iOS simulator. Boot one first: `open -a Simulator`.                                       |
   | `make dev-android` | Android emulator.                                                                         |

   Use these, not the `bun tauri:dev:*` scripts underneath. Each starts the backend and works around a failure mode ([Mobile Setup](./mobile-setup.md) has the detail):
   - Tauri brings its own Vite, so `make run` alongside `bun tauri:dev:desktop` collides on `:1420`.
   - `tauri ios dev` matches simulators by name, otherwise auto-selecting a Wi-Fi-paired iPhone.
   - `gen/android` is committed for the production identifier, so an Android dev build must re-init it for the `.dev` one or it crashes with `ClassNotFoundException`.

5. **Sign in.** Open `http://localhost:1420`, create an account, send a message.

## Common Issues

| Symptom                                             | Fix                                                                                                                                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `make up` port conflict                             | Something is bound to `5433` or `8080`. Stop it or edit `powersync-service/docker-compose.yml`.                                          |
| `make up` fails with a Postgres data-format error   | The Postgres image was bumped to v18, changing its on-disk layout. `make nuke` wipes the old volume and re-inits (loses local DB state). |
| Backend errors with `BETTER_AUTH_SECRET`            | Run `make doctor`, or set it manually with `openssl rand -base64 32`.                                                                    |
| `powersyncJwtSecret must be at least 32 characters` | Set `POWERSYNC_JWT_SECRET` in `backend/.env` to match the one in `powersync-service/config/config.yaml`.                                 |
| Playwright on Ubuntu 26.04 ARM64                    | `make setup` automatically uses Playwright's Ubuntu 24.04 ARM64 browser build until Playwright supports 26.04.                           |
| Tests behave weirdly                                | Fake timers are globally installed. See [testing.md](./testing.md).                                                                      |

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

The license-header step is the part of `make check` a first contribution most often trips on: every source file needs the three-line MPL-2.0 header. `bun run license:fix` adds it; `scripts/license-headers.ts` knows the comment syntax for `.ts`, `.tsx`, `.js`, `.jsx`, `.cjs`, `.mjs`, `.css`, `.scss`, `.rs`, `.kt`, `.kts`, `.sh`, `.sql`, `.html`, `.astro`. The pre-commit hook runs it over staged files, so the failure usually only surfaces when committing outside the hook.

## Next Steps

- [Configuration Reference](../self-hosting/configuration.md): every backend env var.
- [Mobile Setup](./mobile-setup.md): iOS / Android / desktop Tauri prerequisites.
- [Architecture](../architecture/): how the pieces connect.
- [Testing](./testing.md): each suite, the global fake timers, the `mock.module()` hazard, Playwright e2e.
- [Composite Primary Keys and Default Data](../architecture/composite-primary-keys-and-default-data.md) and [Multi-Device Sync](../architecture/multi-device-sync.md#adding-a-new-synced-table): schema rules for synced tables.
- [Self-Hosting](../self-hosting/): deploying Thunderbolt.
