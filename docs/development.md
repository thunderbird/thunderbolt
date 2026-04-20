# Development

## Quick Start

You must have Bun, Rust, and Docker installed first. Then:

## Desktop (Linux)

> ⚠️ Linux desktop builds require system dependencies for Tauri/WebKit. On Ubuntu/Debian, install:
> ```bash
> sudo apt install libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev \
>   build-essential curl wget file libxdo-dev libssl-dev \
>   libayatana-appindicator3-dev librsvg2-dev libsoup-3.0-dev
> ```
> See [Tauri's Linux prerequisites](https://v2.tauri.app/start/prerequisites/#linux) for other distributions.
>
> **Note**: Linux desktop is supported for production builds but WebView is untested on Linux (see [webview.md](./webview.md)).

```sh
# Install dependencies
make setup

# Set up .env files
cp .env.example .env
cd backend && cp .env.example .env
cd ..

# Install sccache (required for desktop builds)
# cargo install sccache  # or: npm install -g sccache

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
