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

Because the artifact is prebuilt, it is verified two ways:

- **Tamper-evidence (CI):** `src/acp/iroh/pkg/CHECKSUMS.txt` lists the sha256 of each
  committed file. The `wasm-artifact` CI job runs `shasum -a 256 -c CHECKSUMS.txt`
  and fails if any committed artifact drifts from the manifest. No toolchain needed.
- **Reproducibility (local):** `./build.sh --verify` rebuilds into a throwaway dir on
  the pinned toolchain and fails if the result drifts from `CHECKSUMS.txt`.

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

Two clean builds (`cargo clean` between) on the pinned toolchain produce a
bit-identical `thunderbolt_acp_client_bg.wasm` (and identical `.js`/`.d.ts`):

```
b4aeee5fc3b67f2b1d22696a77e2ba6038b6f8150a0ff68077896f33c1398d5c  (build 1)
b4aeee5fc3b67f2b1d22696a77e2ba6038b6f8150a0ff68077896f33c1398d5c  (build 2)
```

wasm-opt is deterministic here, so it is **not** a source of drift. What the build
does **not** survive is a change of machine: the artifact embeds absolute
`~/.cargo/registry/...` paths in dependency panic-location strings, so a Linux CI
rebuild cannot match a macOS build hash-for-hash. That is why CI verifies the
committed artifact against `CHECKSUMS.txt` (tamper-evidence) rather than rebuilding
and comparing — a rebuild-and-compare gate would be red by construction across the
CI/dev OS boundary. Reproduce a bit-identical artifact locally on the pinned
toolchain with `./build.sh --verify`.
