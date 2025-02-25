# Mozilla Assist

Stack: Tauri + React + Typescript

## Setup

```sh
git clone --recursive https://github.com/thoughtfulllc/assist # Be sure to use --recursive in order to include the external Rust crates in src-tauri/workspace
# If you forgot to use --recursive, you can `cd src-tauri/workspace/<submodule> && git submodule update --init --recursive`
bun install
```

## Run

```sh
bun run tauri dev
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


## Generate Entities (Database Models)

This will generate the SeaORM entities (e.g., database models / schemas) from the current schema of the SQLite database.

```sh
cd src-tauri

sea-orm-cli generate entity -o entity/src
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
