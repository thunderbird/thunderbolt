## Core Principles

- **Bias towards tasteful simplicity** - favor elegant, readable, maintainable solutions that add minimal complexity. Avoid over-engineering, premature optimization, and defensive coding patterns that obscure intent.
- **Always implement proper, architectural solutions** - no shortcuts, hacky fixes, or temporary workarounds. Research best practices when needed.
- **Prefer optimistic code over defensive code** - let errors surface loudly during development rather than wrapping everything in if-checks and try/catch blocks. Handle errors architecturally at higher levels (e.g., error handling middleware).
- **Deletes (soft vs hard)**  
  - **Frontend**: Never hard delete. Always soft delete data (set `deletedAt`; call APIs that update rather than permanently remove). The only exception is flows that explicitly perform account or device removal (e.g. “Delete account”), which call backend endpoints that hard delete by design.  
  - **Backend**: Prefer soft deletes—set `deletedAt` and filter out soft-deleted records in queries. Use hard delete only when required: e.g. account deletion (user and related data), PowerSync delete operations, or other cases where permanent removal is by design.
- **Question and recommend alternatives** - your goal is better outcomes, not blind execution. Stop and ask for input when appropriate.

## TypeScript & Code Style

- Never use `any` in TypeScript
- Prefer `type` over `interface`
- Prefer arrow functions over `function` keyword
- Prefer `const` over `let` - create helper functions with early return instead of setting `let` variables inside conditionals
- Use camelCase for const and variable names
- Prefer early return over long if statements and nested code
- Use direct imports: `useEffect` not `React.useEffect`
- Prefer async/await over .then/.catch
- Add JSDoc comments to new utility functions
- Only comment non-obvious code - avoid useless comments like "// Save data collection mutation" before `saveDataCollection()`
- Loosely prefer one React component per file

## Tooling & Libraries

- Use `bun` instead of `npm`
- Use `bun test` instead of `vitest`
- Install latest versions: `bun add <package>@latest`
- Prefer `ky` over `fetch`
- Generate Drizzle migrations with `bun db generate` - never manually create SQL files
- Use `resolve-library-id` and `get-library-docs` tools for library documentation (if unavailable, request access)

## React Patterns

- Use `useReducer` when a component needs 3+ `useState` hooks
- Abstract state/logic into `use[Component]State()` hooks to separate computation from display logic and enable unit testing

## Testing

- Create test files as `<file>.test.ts` next to source files
- Test likely edge cases, aiming for useful 80% coverage

## After Each Task

- Consider refactoring into standalone functions for clarity
- Remove unused variables and imports
- Verify tests pass and no TypeScript errors exist

## PowerSync and synced tables

See [docs/powersync-account-devices.md](docs/powersync-account-devices.md) for: synced table requirements, adding a new table (frontend + backend + schema + config.yaml + production), account deletion, device management, and backend token/revoke API.

## CORS and API headers

When adding new custom headers to API requests (e.g. `X-Device-ID`, `X-Device-Name`), update `backend/src/config/settings.ts` so `corsAllowHeaders` includes them. Otherwise CORS preflight will fail and requests from the browser will be blocked.
