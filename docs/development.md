# Development

## Quick Start

You must have these tools installed first:

- [Bun](https://bun.com/)
- [Rust](https://www.rust-lang.org/tools/install)
- Docker or a Docker-compatible runtime
- `sccache`, required by `src-tauri/.cargo/config.toml`:

  ```sh
  cargo install sccache
  ```

For Linux desktop builds, also install Tauri's Linux system prerequisites before
running `cargo check` in `src-tauri` or `bun tauri:dev:desktop`. On
Debian/Ubuntu:

```sh
sudo apt install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
  build-essential curl wget file libxdo-dev libssl-dev \
  libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
```

For other distributions, use the upstream
[Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux).

Then:

```sh
# Install dependencies
make setup

# Set up .env files
cp .env.example .env
cd backend && cp .env.example .env
cd ..

# Run postgres + powersync
make up

# Run backend
# cd backend && bun dev

# Browser:
bun dev
# -> open http://localhost:1420 in your browser.

# Desktop
bun tauri:dev:desktop

# iOS Simulator
bun tauri:dev:ios

# Android Emulator
bun tauri:dev:android
```

## Testing

```sh
# Run frontend tests (src/ and scripts/)
bun run test

# Run frontend tests in watch mode
bun run test:watch

# Run backend tests
bun run test:backend

# Run backend tests in watch mode
bun run test:backend:watch
```

**Note**: Don't use `bun test` without the npm script from the project root, as it will pick up both frontend and backend tests. The `test` script is configured to only run tests in `./src` and `./scripts` directories.

See [testing.md](./testing.md) for detailed testing guidelines.
