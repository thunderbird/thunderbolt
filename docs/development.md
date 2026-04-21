# Development

## Quick Start

You must have Bun, Rust, and Docker installed first.

### Linux System Prerequisites

If you're on Linux (e.g. Ubuntu 24.04), install the following system dependencies before running `make setup`, or `cargo check` will fail with missing library errors:

```bash
sudo apt install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev   build-essential curl wget file libxdo-dev libssl-dev   libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
```

Alternatively, see [Tauri's Linux prerequisites guide](https://v2.tauri.app/start/prerequisites/#linux).

Then:

```sh
# Install dependencies
make setup

# Set up .env files
cp .env.example .env
cd backend && cp .env.example .env
cd ..

# Run postgres + powersync
make docker-up

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
