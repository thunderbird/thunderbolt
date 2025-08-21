# Thunderbolt [[Demo]](https://thunderbolt-h9p7.onrender.com)

**_(Formerly known as Mozilla Assist(ant))_**

[![CI](https://github.com/thunderbird/thunderbolt/actions/workflows/ci.yml/badge.svg)](https://github.com/thunderbird/thunderbolt/actions/workflows/ci.yml)

![Thunderbolt Main Dashboard](./docs/screenshots/main.png)
![Thunderbolt Chat](./docs/screenshots/chat.png)

## Stack:

- TypeScript
- Rust
- Tauri - for creating the desktop / mobile application
- React - for the UI
- Tailwind - for styling
- Shadcn - for UI components
- React Router - for navigation / route handling
- libsql - for local data storage, vector store, and encryption at rest
- Drizzle - for ORM / migrations (eventually hoping to migrate this to SQLx / SeaORM in Rust)
- Vercel AI SDK - for handling the chat thread state, streaming LLM responses, and handling LLM tool calls
- Mistral + Candle - for running embedding, and possibly LLMs, on-device via Hugging Face
- Zod - for JSON schema validation
- Vite - frontend package bundler
- UUID - for all IDs - using v7 so that we can derive "created at" times from IDs and save disk space
- Rust: imap, mail-parser, html2text - for syncing and parsing emails
- Storybook: build, test & document components

## Rust Setup

```sh
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Use the Nightly toolchain
rustup toolchain install nightly

# Install sccache globally
cargo install sccache

# Install cmake
brew install cmake # Mac only
```

## Setup

### Prerequisites

- [Rust](https://rustup.rs/) - See Rust Setup section below
- [Bun](https://bun.sh/) - JavaScript runtime and package manager
- [uv](https://github.com/astral-sh/uv) - Python package manager for backend
- Python 3.9+ - For Flower framework and backend

### Quick Setup

```sh
# Clone the repository with submodules
git clone --recurse-submodules https://github.com/thunderbird/thunderbolt.git
cd thunderbolt

# Run the setup command to initialize everything
make setup
```

The `make setup` command will:

1. Initialize and update git submodules (including the Flower framework)
2. Install frontend dependencies with bun
3. Install backend dependencies with uv
4. Configure Flower framework environment (optional - manual installation may be needed)

### Manual Setup (if needed)

```sh
# Initialize submodules
git submodule update --init --recursive

# Install frontend dependencies
bun install

# Install backend dependencies
cd backend && uv sync --frozen && cd ..

# Set up Flower framework (optional)
cd flower/framework && pip install -e . && cd ../..
```

## Run

```sh
bun tauri dev
```

### Enabling optional Rust features (e.g. libsql)

The Rust backend is built with **Cargo features**. By default **no optional
features are enabled**, which keeps the binary size small and avoids pulling in
dependencies you might not need during early development.

| Feature      | What it enables                                     |
| ------------ | --------------------------------------------------- |
| `libsql`     | Local encrypted SQLite replacement via libsql       |
| `email`      | IMAP client, mail-parser and related commands       |
| `embeddings` | On-device embeddings generation (Candle)            |
| `bridge`     | Native messaging bridge for the Thunderbird add-on  |
| `all`        | A convenience feature that enables all of the above |

You can pass features to any `tauri` CLI command by adding a `--` separator —
everything after it is forwarded to `cargo`:

```sh
# Run the app with libsql support enabled
bun tauri dev -- --features libsql

# Build a production bundle with all optional features
bun tauri build -- --features all

# If you ever need to explicitly remove default features in the future:
bun tauri dev -- --no-default-features --features libsql,email
```

Note: when a feature is not compiled in, its corresponding commands are
omitted from the binary. The renderer detects that automatically through the
`capabilities` command we added, so no runtime errors occur — the feature is
simply unavailable in the UI.

## Run Rust Examples

Important! Embed and mistral need to be built for release - they will hang you just run them with `cargo run --bin embed` in debug mode.

```sh
cd src-tauri

# imap
# Note: Can be run with cargo in debug mode.
cargo run --bin imap

# mistral - must be built for release to work!
cargo build --bin mistral --release
./target/release/mistral

# embed - must be built for release to work!
cargo build --bin embed --release
./target/release/embed
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

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Building for Devices

```sh
rustup toolchain install nightly
rustup override set nightly
rustup target add aarch64-apple-ios-sim # Add your device architecture (replace "aarch64-apple-ios-sim" with the desired device architecture)
bun run tauri ios dev --force-ip-prompt --host # Be sure to select the IP of your dev computer on the local network
```

- https://tauri.app/develop/#developing-your-mobile-application
- https://github.com/sarah-quinones/gemm/issues/31#issuecomment-2395557397

## Documentation

- [Release Process](./RELEASE.md) - Instructions for creating and publishing new releases
