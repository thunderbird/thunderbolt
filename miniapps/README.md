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

One bun workspace, installed from `miniapps/`. Install once at the root and every
package is linked:

```sh
cd miniapps
bun install

cd template          # bun dev → http://localhost:5190
cd samples/finance   # bun dev → http://localhost:5174
```

The template's `:5190` is the port the backend's development `MINI_APPS` fallback and
`src-tauri/tauri.dev.conf.json`'s `frame-src` both already name, so a fresh checkout
needs no configuration to see it. Another port means updating both.

Then point Thunderbolt at it. See `docs/` in the repo root for registering a Mini App
with the host.

## Deploying against a real host

Two settings, and both are needed. They answer different questions, and getting
either wrong produces the same symptom: a blank panel.

| Variable                              | Answers                                       | Read by                                |
| ------------------------------------- | --------------------------------------------- | -------------------------------------- |
| `NEXT_PUBLIC_THUNDERBOLT_HOST_ORIGIN` | who the app talks to, and trusts replies from | the browser, via `useThunderbolt`      |
| `THUNDERBOLT_HOST_ORIGINS`            | who is allowed to frame the app               | `next.config.ts`, as `frame-ancestors` |

Unset, both fall back to the development origins (`http://localhost:1420` plus
the desktop app's `tauri://localhost` and `http://tauri.localhost`). Until
THU-908 the React path had no way to pass the first of these at all, so a
deployed app could only ever target the dev server.

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

The template and samples take it from the workspace:

```json
"@thunderbolt/miniapp-sdk": "workspace:*"
```

Not `file:../sdk`. On Linux, bun installs a `file:` dependency as one symlink **per
file**, and Turbopack cannot follow file symlinks, so `next dev` died with "package.json
is not parseable: a redirect can't be parsed as json" ([vercel/next.js#87647](https://github.com/vercel/next.js/issues/87647)).
A workspace dependency links the directory once instead. Each app's `next.config.ts`
also sets `turbopack.root` to `miniapps/`, because the linked SDK resolves outside the
app's own package and Turbopack refuses to follow a link that leaves its root.

This works for anything inside this repo. **It does not work for an app outside it** —
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
