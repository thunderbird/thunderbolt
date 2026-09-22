# Storybook

```sh
bun storybook         # dev server on http://localhost:6006/
bun build-storybook   # static build
```

Configuration lives in `.storybook/`: `main.ts` holds the story globs, the addon list and the Vite overrides; `preview.tsx` holds the global decorators and parameters. For Storybook's own API see the [official documentation](https://storybook.js.org/).

## Where stories live

`.storybook/main.ts:16` matches three globs under `src/`, and all three have live files:

| Form                                       | Files | Example                                      |
| ------------------------------------------ | ----- | -------------------------------------------- |
| `<name>.stories.tsx` next to the component | 39    | `src/components/ui/button.stories.tsx`       |
| `src/stories/<Name>.stories.tsx`, detached | 17    | `src/stories/ExternalLinkDialog.stories.tsx` |
| bare `stories.tsx` in a widget folder      | 4     | `src/widgets/map/stories.tsx`                |

**Write new stories in the first form.** Colocation is the house rule for a component's satellite files (`AGENTS.md:62`), kebab-case is the repo's filename convention, and a colocated story imports its subject with a relative `./` path where a detached one has to reach back through the `@/` alias. The other two forms predate that preference; nothing is migrating them, so leave them where they are.

They are not dead code, so the globs stay — `src/stories/` last gained a file in May 2026 and `ExternalLinkDialog.stories.tsx` was edited again in September 2026 (#1244) — but the direction is visible in the widgets: the last bare `stories.tsx` was added in June 2026 and the newest widget story, `src/widgets/weather-forecast/display.stories.tsx` (July 2026), uses the named form. The bare form also carries a cost that folder shows directly: it holds both `stories.tsx` and `display.stories.tsx`, and the two declare the same `title: 'Widgets/WeatherForecast'` (`stories.tsx:45`, `display.stories.tsx:24`).

`title` is the sidebar path, not the file path — `UI/…` for `src/components/ui`, plus `Chat/`, `Sidebar/`, `Skills/`, `Widgets/`, `Settings/`, `Onboarding/` and `Components/`. Pick the namespace that matches the feature, not the directory the file happens to sit in: `src/stories/ExternalLinkDialog.stories.tsx` is titled `Chat/ExternalLinkDialog`.

`main.ts:16` also globs `../src/**/*.mdx`, but no `.mdx` file exists under `src/` today.

## What a story gets for free

`.storybook/preview.tsx` wraps every story in three decorators, each mirroring a wrapper the real app applies in `src/app.tsx`:

- `I18nProvider` with `src/i18n` imported, which activates the source locale synchronously — so `<Trans>` renders the English source without loading a catalog.
- `LazyMotion` with `domMax` in `strict` mode. Without it `m.*` components silently never animate, and a story using `initial={{ scale: 0 }}` renders invisible at its initial pose.
- `withThemeByClassName`, driving the light/dark toolbar toggle through a `dark` class on the root — the same signal `src/index.css`'s `@variant dark` keys off.

That is the whole list. There is no router, no TanStack Query client, no database and no tooltip or sidebar context, so anything reaching for those must bring its own decorator: see `src/layout/sidebar/nav-toggle.stories.tsx:25` (`BrowserRouter` → `SidebarProvider` → `TooltipProvider`) and `src/stories/onboarding/wrappers/OnboardingAuthStepWrapper.tsx`, which wraps `MemoryRouter` and stubs the OAuth hook through its DI seam.

## Vite overrides

Storybook runs its own Vite server, so `viteFinal` in `.storybook/main.ts` repeats two things from `vite.config.ts`:

- `bun:sqlite` is marked external (`main.ts:41`). It is a Bun runtime module with no browser equivalent, imported by `src/db/bun-sqlite-database.ts`; without the exclusion the build fails on any story whose import graph reaches it.
- The `@fs` allowlist (`main.ts:45-56`) mirrors `vite.config.ts:210-222`. Adding a served directory means editing both.

## Tests

`vite.config.ts:230-256` defines a single Vitest project named `storybook`: `storybookTest()` pointed at `.storybook/` turns every story into a test case, running headless Chromium through Playwright with `.storybook/vitest.setup.ts` as its setup file, which merges `@storybook/addon-a11y`'s annotations into `preview.tsx`'s.

**Nothing runs it, and as configured it cannot run.** `package.json` has only `storybook` and `build-storybook` — no `vitest` script — and no workflow under `.github/workflows/` mentions vitest, storybook or chromatic. `bunx vitest --project=storybook` then fails during config resolution: Vitest 4 (4.1.7 installed) replaced the string form of `browser.provider` with a factory imported from `@vitest/browser-playwright`, which is not a dependency, while `vite.config.ts:246` still passes `provider: 'playwright'`. Because `test.projects` contains only this project, every `vitest` invocation in the repo hits the same error.

Treat the story test layer as inactive. Reviving it needs the provider migration, a script, and a CI job — at which point `a11y.test` in `preview.tsx:89` matters: it is set to `'todo'`, which reports violations in the test UI rather than failing, and only `'error'` makes them break a build. `@chromatic-com/storybook` is registered as an addon (`main.ts:18`) but likewise has no workflow behind it.

`AGENTS.md:51` says to use `bun test` rather than `vitest`. That rule is about unit tests. The Storybook layer is browser-mode and arrives as a Vitest plugin (`@storybook/addon-vitest/vitest-plugin`), so it could only ever run under Vitest; it is not a precedent for writing new unit tests there.

## Localization

`lingui.config.ts:35` excludes `**/*.stories.*` from extraction, keeping story copy out of the translator catalogs. That glob does not match a bare `stories.tsx` basename, so a Lingui macro in one of the four widget story files would extract into `src/locales/`. None of them imports a macro today, so the hole is latent — and it is one more reason to use the `<name>.stories.tsx` form.
