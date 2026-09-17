# Thunderbolt Mini Apps

A Mini App is an ordinary web app that Thunderbolt embeds in an iframe. It publishes
context the chat can read, exposes tools the model can call, and can let the user
point at one of its elements.

| Directory          | What it is                                                       |
| ------------------ | ---------------------------------------------------------------- |
| `sdk/`             | Guest-side client for the bridge. The only copy.                 |
| `template/`        | Minimal starter. Copy it to begin a new app.                     |
| `samples/finance/` | A worked example — a quarterly revenue model the chat can drive. |

## Running one locally

Each package installs on its own; there is no root workspace, matching `cli/` and
`backend/`.

```sh
cd template        # or samples/finance
bun install
bun dev            # http://localhost:3000
```

Then point Thunderbolt at it. See `docs/` in the repo root for registering a Mini App
with the host.

## The two headers that decide whether it works

Both failures look identical — a blank panel, no console error in the embedding page —
so get them right before debugging anything else. `next.config.ts` in the template sets
both, with the reasoning inline:

- **`Content-Security-Policy: frame-ancestors`** — a browser refuses to render a frame
  whose CSP does not list the embedder, and Next.js sets no CSP by default. Without it
  the app works standalone and silently refuses to embed.
- **`Cross-Origin-Embedder-Policy` + `Cross-Origin-Resource-Policy`** — Thunderbolt is
  cross-origin isolated (PowerSync's wa-sqlite worker needs `SharedArrayBuffer`), and a
  cross-origin iframe inside a COEP document has to opt in or it is blocked. This is not
  a Thunderbolt quirk; it applies to any cross-origin-isolated host.

## Depending on the SDK

The template and samples reference it by path:

```json
"@thunderbolt/miniapp-sdk": "file:../sdk"
```

That works for anything inside this repo. **It does not work for an app outside it** —
publishing the SDK is what makes it consumable by third parties, and that is not done
yet. Until then, an external app copies `sdk/src/` in.

## Conventions

These packages follow the repo's conventions (see the root `CLAUDE.md`), enforced rather
than merely followed: `miniapps/eslint.config.js` lints all three, the root
`license:check` walks `git ls-files` so it covers them automatically, and each package
has its own `typecheck`.

```sh
bun run lint          # from miniapps/
bun run format-check
cd sdk && bun run typecheck
```

One rule is specific to this directory: the bridge must never `postMessage` to `'*'`,
because that broadcasts app state to whatever page happens to be framing it. There is a
lint rule for it.
