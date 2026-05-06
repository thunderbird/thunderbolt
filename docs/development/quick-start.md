# Quick Start

This walks through running Thunderbolt locally: backend API, PowerSync sync service, and the Vite frontend.

## Prerequisites

- **[Bun](https://bun.sh/)** 1.2+
- **Rust toolchain** — needed for the Tauri desktop and mobile builds. Install via [rustup](https://rustup.rs/).
- **sccache** — speeds up Rust rebuilds. Install with `cargo install sccache`. Configured in `src-tauri/.cargo/config.toml`.
- **Docker** — PowerSync and PostgreSQL run in containers during local dev.

For Linux desktop builds, also install Tauri's Linux system prerequisites before running `cargo check` in
`src-tauri` or `bun tauri:dev:desktop`. On Debian/Ubuntu:

```bash
sudo apt install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
  build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
```

For other distributions, use the upstream
[Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

Run `make doctor` after cloning to verify your environment is set up correctly. It prints exact install commands for anything missing.

You'll also need at least one AI provider API key — Anthropic, OpenAI, Mistral, Fireworks, or any OpenAI-compatible endpoint (Ollama and llama.cpp are recommended for local inference).

## Bootstrap

1. **Clone and install.**

   ```bash
   git clone https://github.com/thunderbird/thunderbolt.git
   cd thunderbolt
   make setup
   ```

   `make setup` installs frontend and backend dependencies and wires up the Claude Code agent symlinks.

2. **Create `.env` files.**

   ```bash
   cp .env.example .env
   cd backend && cp .env.example .env && cd ..
   ```

   At a minimum set `BETTER_AUTH_SECRET` (any 32+ character string) and one provider key in `backend/.env`. See [Configuration](../self-hosting/configuration.md) for the full list.

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

   Backend starts on `http://localhost:8000`, frontend on `http://localhost:5173`.

   _Desktop (Tauri):_ `bun tauri:dev:desktop`

   _iOS simulator:_ `bun tauri:dev:ios`

   _Android emulator:_ `bun tauri:dev:android`

5. **Sign in.** Open `http://localhost:5173`, create an account, and send a message. If it works, you're good.

## Common Issues

- **`make up` port conflict** — something is bound to `5433` or `8080`. Stop it or edit `powersync-service/docker-compose.yml`.
- **Backend errors with `BETTER_AUTH_SECRET`** — Zod validates this on startup. Generate one with `openssl rand -hex 32` and put it in `backend/.env`.
- **`powersyncJwtSecret must be at least 32 characters`** — same fix. The secret must match the one baked into `powersync-service/config/config.yaml`.
- **Tests behave weirdly** — fake timers are globally installed; see [testing.md](./testing.md).

## Helpful Makefile Targets

| Command                 | What it does                                                         |
| ----------------------- | -------------------------------------------------------------------- |
| `make doctor`           | Verifies your tools + env files. `make doctor-q` only prints issues. |
| `make run` / `make dev` | Starts backend + frontend. Kills stale processes on `:8000` and `:5173` first. |
| `make up`               | Starts PowerSync and Postgres.                                       |
| `make down`             | Stops containers, keeps volumes.                                     |
| `make nuke`             | Wipes all container data and rebuilds from scratch.                  |
| `make check`            | Runs type-check, lint, and format-check.                             |
| `make format`           | Formats frontend, backend, and Rust.                                 |

## Next Steps

- [Configuration Reference](../self-hosting/configuration.md) — every backend env var.
- [Architecture](../architecture/) — how the pieces connect.
- [Testing](./testing.md) — test patterns, composite keys, synced table rules.
- [Self-Hosting](../self-hosting/) — deploy Thunderbolt somewhere real.
