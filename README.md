# Thunderbolt [[Demo]](https://www.thunderbolt.io)

[![CI](https://github.com/thunderbird/thunderbolt/actions/workflows/ci.yml/badge.svg)](https://github.com/thunderbird/thunderbolt/actions/workflows/ci.yml)

![Thunderbolt Main Dashboard](./docs/screenshots/main.png)

## Quick Start

The quickest way to get started is with [Claude Code](https://docs.anthropic.com/en/docs/claude-code). From the repo root, run `claude` and then type `/thunderup` — it installs dependencies, starts Docker, and verifies your environment in one shot. See [docs/claude-code.md](./docs/claude-code.md) for the full list of slash commands.

Alternatively, for a manual setup:

1. Create a `.env` file with:
   ```
   VITE_THUNDERBOLT_CLOUD_URL=https://api.thunderbolt.io
   ```
2. Run `bun dev`
3. Open http://localhost:1420 in your browser

This runs a standard Vite dev server without requiring the Tauri desktop shell or backend setup.

## Architecture Overview

Thunderbolt is a **cross-platform, local-first** app built with [Tauri](https://tauri.app/) and TypeScript. Tauri provides a Rust backend layer that enables native capabilities like file system access and performance-critical operations.

### Local Database Storage

All data is stored on-device using [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) via [wa-sqlite](https://github.com/powersync-ja/wa-sqlite) with web workers and [PowerSync](https://www.powersync.com/) for offline-first sync.

- No Rust compilation required
- Runs database operations in a separate thread for better performance
- Works in both browser (`bun dev`) and Tauri builds

### Development Modes

- **Browser-only** (`bun dev`): Standard Vite dev server — no Rust features, fast iteration
- **Tauri desktop** (`bun tauri dev`): Full app with Rust capabilities
  - Access dev tools with `Cmd+Shift+I` (same as browsers)
  - All database logic and migrations run in the frontend (local-first architecture)

## Stack:

- TypeScript
- Rust
- Tauri - for creating the desktop / mobile application
- React - for the UI
- Tailwind - for styling
- Shadcn - for UI components
- React Router - for navigation / route handling
- Drizzle - for ORM / migrations
- Vercel AI SDK - for handling the chat thread state, streaming LLM responses, and handling LLM tool calls
- Zod - for JSON schema validation
- Vite - frontend package bundler
- UUID - for all IDs - using v7 so that we can derive "created at" times from IDs and save disk space
- Storybook: build, test & document components

## Rust Setup

```sh
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install sccache globally
cargo install sccache

# Install cmake
brew install cmake # Mac only
```

## Setup

### Prerequisites

- [Rust](https://rustup.rs/) - See Rust Setup section below
- [Bun](https://bun.sh/) - JavaScript runtime and package manager

### Quick Setup

```sh
# Clone the repository
git clone https://github.com/thunderbird/thunderbolt
cd thunderbolt

# Run the setup command to initialize everything
make setup
```

The `make setup` command will install all frontend and backend dependencies.

### Manual Setup (if needed)

```sh
# Install frontend dependencies
bun install

# Install backend dependencies
cd backend && bun install
```

## Testing

```sh
# Run frontend tests (src/ and scripts/)
bun test

# Run frontend tests in watch mode
bun test:watch

# Run backend tests
bun test:backend

# Run backend tests in watch mode
bun test:backend:watch
```

**Note**: Don't use `bun test` without the npm script from the project root, as it will pick up both frontend and backend tests. The `test` script is configured to only run tests in `./src` and `./scripts` directories.

See [docs/testing.md](./docs/testing.md) for detailed testing guidelines.

## Code Formatting

Thunderbolt uses automated code formatting to maintain consistent code style across the entire project.

### Automatic Pre-commit Formatting

Staged git files are automatically formatted before commits via lint-staged:

- **Frontend files** (`.ts`, `.tsx`, `.js`, `.jsx`, `.json`, `.css`, `.md`) are formatted with Prettier
- **Rust files** (`.rs`) are formatted with cargo fmt

### Manual Formatting Commands

```sh
# Format all code (frontend, Rust)
make format

# Check formatting without modifying files
make format-check
```

## Run

```sh
bun tauri:dev:desktop
```

## Run Android

```sh
# Android builds work with default (empty) features
bun tauri android dev
```

## Run Storybook [[DEMO]](https://thunderbolt-storybook.onrender.com/?path=/docs/components-ui-button--docs)

Check the [official](https://storybook.js.org/) documentation for usage instructions and examples.

```sh
bun storybook
# open in your browser http://localhost:6006/

# to build
bun build-storybook
```

## Analyze Vite Modules

Thunderbolt ships with [vite-bundle-analyzer](https://github.com/victorb/vite-plugin-bundle-analyzer) wired in, but **it is disabled by default** so it doesn't slow down normal builds or break CI on missing `stats.html`.

There are two ways to turn it on:

1. Run the dedicated script (convenient for local use):

   ```sh
   bun analyze   # alias for `vite analyze`
   ```

2. Toggle it for any build by setting an environment variable (handy in CI):

   ```sh
   ANALYZE=true bun run build   # generates dist/stats.html alongside a normal production build
   ```

In both cases the plugin runs in _static_ mode and writes `dist/stats.html`; it will **not** try to open a browser automatically.

## Tauri Signing Keys

### Generate New Signing Keys Securely

```sh
# Create the .tauri directory in your home folder (if it doesn't exist)
mkdir -p ~/.tauri

# Generate a cryptographically secure password
PASSWORD=$(openssl rand -base64 32)

# Display the password (save this securely - you'll need it for signing)
echo "Your signing key password: $PASSWORD"

# Generate new Tauri signing keys
tauri signer generate -p "$PASSWORD" -w ~/.tauri/thunderbolt.key

# The keys will be created at:
# Private key: ~/.tauri/thunderbolt.key (Keep this secret!)
# Public key: ~/.tauri/thunderbolt.key.pub
```

### Important Security Notes

- **Never share your private key** with anyone
- **Never commit the private key** to version control
- **Store the password securely** (password manager recommended)
- If you lose the private key or password, you won't be able to sign updates

### Using the Keys

Set these environment variables when signing:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/thunderbolt.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-password-here"
```

## Building for Devices

```sh
rustup target add aarch64-apple-ios-sim # Add your device architecture (replace "aarch64-apple-ios-sim" with the desired device architecture)
bun run tauri ios dev --force-ip-prompt --host # Be sure to select the IP of your dev computer on the local network
```

- https://tauri.app/develop/#developing-your-mobile-application
- https://github.com/sarah-quinones/gemm/issues/31#issuecomment-2395557397

## Thunderbot Skills

The Claude Code slash commands in `.claude/commands/` are managed via [git subtree](https://www.atlassian.com/git/tutorials/git-subtree) from the [thunderbot](https://github.com/user/thunderbot) repo. This means you can edit them here as normal files and sync changes in both directions.

```bash
# Pull latest skills from thunderbot
git subtree pull --prefix=.claude/commands thunderbot main --squash

# Push local skill edits back to thunderbot
git subtree push --prefix=.claude/commands thunderbot main
```

If you haven't added the remote yet:

```bash
git remote add thunderbot git@github.com:thunderbird/thunderbot.git
```

## Documentation

- [Claude Code Skills](./docs/claude-code.md) - Slash commands for bootstrapping, code quality, automation, and more
- [Release Process](./RELEASE.md) - Instructions for creating and publishing new releases
- [Telemetry](./TELEMETRY.md) - Information about data collection and privacy policy
