# thunderbolt-acp-client

Relay-only [iroh](https://www.iroh.computer/) client, compiled to WebAssembly, that
dials a Thunderbolt CLI ACP/MCP bridge over an n0 relay. The web app lazy-imports
the wasm-pack glue from `src/acp/iroh/pkg/`.

## Prebuilt artifact in tree

The compiled output (`src/acp/iroh/pkg/`) is **committed to the repo** so the app —
and CI — can import it without a wasm toolchain (`ring` compiles C crypto to
`wasm32`, which needs a wasm-capable clang; see [`build.sh`](./build.sh)). This is a
deliberate binary-in-tree decision for a P2P/QUIC security core, so its provenance
is anchored below and enforced by CI.

Because the artifact is prebuilt, it is verified three ways:

- **Staleness gate (CI):** the `wasm-artifact` job also triggers when the crate source
  changes (`src/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/`,
  `build.sh`). If the crate changed without a matching `src/acp/iroh/pkg/` regeneration
  in the same PR, the job fails — so editing the crate can't silently leave the
  committed wasm stale. No toolchain needed.
- **Tamper-evidence (CI):** `src/acp/iroh/pkg/CHECKSUMS.txt` lists the sha256 of each
  committed artifact. The `wasm-artifact` CI job verifies both exact file-set equality
  and every digest, so changed, missing, or unlisted files fail. No toolchain needed.
- **Reproducibility (local, pinned toolchain):** `./build.sh --verify` rebuilds into a
  throwaway dir and fails if the result drifts from `CHECKSUMS.txt`. Two clean builds on
  the pinned toolchain are bit-identical (see "Determinism test"). CI still verifies the
  committed artifact against `CHECKSUMS.txt` (tamper-evidence + staleness) rather than
  rebuilding — a cross-machine rebuild-verify is now plausible (absolute builder paths
  are remapped out, see below) but not yet wired up.

## Rebuilding

```sh
./build.sh            # rebuild + regenerate CHECKSUMS.txt into src/acp/iroh/pkg
./build.sh --verify   # rebuild into a temp dir and diff against the committed manifest
```

Commit the regenerated `pkg/` (including `CHECKSUMS.txt`) in the same change as any
crate/dependency edit. Bumping the toolchain below also changes the artifact — bump
and regenerate in one commit.

## Toolchain provenance

The build is pinned so it is byte-for-byte reproducible on a matching machine:

| Tool         | Version | Pinned by                                          |
| ------------ | ------- | -------------------------------------------------- |
| rustc        | 1.94.0  | [`rust-toolchain.toml`](./rust-toolchain.toml)     |
| wasm-bindgen | 0.2.126 | `Cargo.lock` (wasm-pack fetches the matching CLI)  |
| wasm-pack    | 0.13.1  | provenance note (installed via `cargo install`)    |
| wasm-opt     | 130     | provenance note (Homebrew `binaryen`)              |

macOS additionally needs Homebrew LLVM clang to compile `ring`'s C to `wasm32`
(Apple's system clang has no wasm backend) — `build.sh` points the wasm C toolchain
at `/opt/homebrew/opt/llvm`.

## Determinism test

Two clean builds (`cargo clean` between) on the pinned toolchain produce identical
artifacts. Current authoritative hashes live in the committed
[`CHECKSUMS.txt`](../../src/acp/iroh/pkg/CHECKSUMS.txt); `./build.sh --verify` rebuilds
and compares against that manifest so this README cannot carry stale duplicate hashes.

wasm-opt is deterministic here, so it is **not** a source of drift. The build no longer
embeds absolute builder paths: `build.sh` passes `--remap-path-prefix` to rewrite
`$CARGO_HOME`→`/cargo` and the repo root→`/build` (std is already `/rustc/<hash>/`), so
the ~750 dependency panic-location strings that used to leak the builder's username are
now machine-independent. That was the one hard blocker to cross-machine reproducibility,
so a Linux-CI rebuild matching this macOS hash is now **plausible** — though still
unproven across the OS/wasm-opt boundary (codegen and wasm-opt output can differ by
platform). Wiring a CI rebuild-verify on the pinned toolchain is possible future work;
today CI verifies the committed artifact against `CHECKSUMS.txt` (tamper-evidence +
staleness) and `./build.sh --verify` reproduces it locally.
