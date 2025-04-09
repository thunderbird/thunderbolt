# Mozilla Assist

Stack:
* TypeScript
* Rust
* Tauri - for creating the desktop / mobile application
* React - for the UI
* Tailwind - for styling
* Shadcn - for UI components
* React Router - for navigation / route handling
* libsql - for local data storage, vector store, and encryption at rest
* Drizzle - for ORM / migrations (eventually hoping to migrate this to SQLx / SeaORM in Rust)
* Vercel AI SDK - for handling the chat thread state, streaming LLM responses, and handling LLM tool calls
* Mistral + Candle - for running embedding, and possibly LLMs, on-device via Hugging Face
* Zod - for JSON schema validation
* Vite - frontend package bundler
* UUID - for all IDs - using v7 so that we can derive "created at" times from IDs and save disk space
* Rust: imap, mail-parser, html2text - for syncing and parsing emails

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

```sh
git clone
bun install
```

## Run

```sh
bun tauri dev
```

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

## Analyze Vite Modules

```sh
bun analyze
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
