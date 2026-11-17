# Admin

The org admin screens: members, groups, invitations, identity providers, domains, link reviews, the audit log and
break-glass. They call the `/v1/admin/*` API, whose request and response types live in `shared/admin-api.ts`.

## Licensing

Everything in this directory is **UNLICENSED, license TBD**, and outside the MPL grant. See [LICENSE](./LICENSE) and
[LICENSING.md](../LICENSING.md). Each file carries the UNLICENSED notice; `bun run license:check` enforces it.

The admin gate, the nav entry, the lazy import (`src/lib/admin-module.ts`), `shared/admin-api.ts` and the backend stay
MPL. Code here may import MPL components from `src/`; nothing in `src/` imports from here except that one loader.

The design comes from Chris Roth's admin prototype (PR #1379), which adapted work by to-be-coder
([workspaces-rethink](https://github.com/to-be-coder/thunderbolt/tree/workspaces-rethink)).

## Layout

- `admin-routes.tsx` and `admin-sidebar.tsx`: the route table and the sidebar config.
- `screens/<area>/`: one folder per screen.
- `components/`: the admin UI kit shared by the screens.
- `api/`: the client, query keys, shared queries, paged lists and error messages.

## Tests

`bun run test:admin` runs `admin/**/*.test.{ts,tsx}` with `admin/bunfig.toml`; `bun run test` includes it. The
Playwright specs are `e2e/admin-<area>.spec.ts`, run by the `admin` and `admin-narrow` projects.
