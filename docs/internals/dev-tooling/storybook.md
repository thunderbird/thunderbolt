# Storybook

```sh
bun storybook         # dev server on http://localhost:6006/
bun build-storybook   # static build
```

`.storybook/main.ts` holds the story globs, addons and Vite overrides; `preview.tsx` holds the global decorators and parameters. For Storybook's own API see the [official documentation](https://storybook.js.org/).

## Where stories live

`.storybook/main.ts:16` matches three globs under `src/`, all live:

| Form                                       | Files | Example                                      |
| ------------------------------------------ | ----- | -------------------------------------------- |
| `<name>.stories.tsx` next to the component | 39    | `src/components/ui/button.stories.tsx`       |
| `src/stories/<Name>.stories.tsx`, detached | 17    | `src/stories/ExternalLinkDialog.stories.tsx` |
| bare `stories.tsx` in a widget folder      | 4     | `src/widgets/map/stories.tsx`                |

**Write new stories in the first form.** Colocation is the house rule for satellite files (`AGENTS.md:62`), kebab-case is the repo convention, and a colocated story imports its subject relatively instead of through `@/`. The other two forms predate it and are not being migrated, so the globs stay.

The bare form carries a cost `src/widgets/weather-forecast/` shows directly: it holds both `stories.tsx` and `display.stories.tsx`, and the two declare the same `title: 'Widgets/WeatherForecast'` (`stories.tsx:45`, `display.stories.tsx:24`).

`title` is the sidebar path, not the file path: `UI/` for `src/components/ui`, plus `Chat/`, `Sidebar/`, `Skills/`, `Widgets/`, `Settings/`, `Onboarding/`, `Components/`. Pick the namespace matching the feature, not the directory (`src/stories/ExternalLinkDialog.stories.tsx` is titled `Chat/ExternalLinkDialog`).

`main.ts:16` also globs `../src/**/*.mdx`; no `.mdx` file exists under `src/` today.

## What a story gets for free

`preview.tsx` wraps every story in three decorators, each mirroring a wrapper `src/app.tsx` applies:

- `I18nProvider` with `src/i18n` imported, activating the source locale synchronously so `<Trans>` renders English with no catalog.
- `LazyMotion` with `domMax` in `strict` mode. Without it `m.*` never animates, and `initial={{ scale: 0 }}` renders invisible.
- `withThemeByClassName`, driving the light/dark toolbar toggle through a `dark` class on the root, the signal `src/index.css`'s `@variant dark` keys off.

No router, Query client, database, tooltip or sidebar context, so anything needing those brings its own decorator. See `src/layout/sidebar/nav-toggle.stories.tsx:25` (`BrowserRouter` → `SidebarProvider` → `TooltipProvider`) and `src/stories/onboarding/wrappers/OnboardingAuthStepWrapper.tsx`, which adds `MemoryRouter` and stubs the OAuth hook through its DI seam.

## Vite overrides

Storybook runs its own Vite server, so `viteFinal` in `main.ts` repeats two things from `vite.config.ts`:

- `bun:sqlite` marked external (`main.ts:41`). A Bun runtime module with no browser equivalent, imported by `src/db/bun-sqlite-database.ts`; without it the build fails on any story whose import graph reaches it.
- The `@fs` allowlist (`main.ts:45-56`) mirrors `vite.config.ts:210-222`. Adding a served directory means editing both.

## Tests

`vite.config.ts:230-256` defines one Vitest project, `storybook`: `storybookTest()` pointed at `.storybook/` turns every story into a test case in headless Chromium via Playwright, with `.storybook/vitest.setup.ts` merging `@storybook/addon-a11y`'s annotations into `preview.tsx`'s.

**Nothing runs it, and as configured it cannot run.** `package.json` has only `storybook` and `build-storybook`, no `vitest` script, and no workflow under `.github/workflows/` mentions vitest, storybook or chromatic. `bunx vitest --project=storybook` fails at config resolution: Vitest 4 (4.1.7) replaced the string `browser.provider` with a factory from `@vitest/browser-playwright`, which is not a dependency, while `vite.config.ts:246` still passes `provider: 'playwright'`. `test.projects` holds only this project, so every `vitest` invocation hits that error.

Treat the layer as inactive. Reviving it needs the provider migration, a script and a CI job. Then `a11y.test` (`preview.tsx:89`) matters: `'todo'` reports violations in the test UI rather than failing, only `'error'` breaks a build. `@chromatic-com/storybook` is an addon (`main.ts:18`) with no workflow behind it.

`AGENTS.md:51` prefers `bun test` over `vitest`, a rule about unit tests. Story tests are browser-mode and ship as a Vitest plugin (`@storybook/addon-vitest/vitest-plugin`), so they can only run under Vitest; not a precedent for new unit tests.

## Localization

`lingui.config.ts:35` excludes `**/*.stories.*` from extraction, keeping story copy out of the translator catalogs. The glob misses a bare `stories.tsx` basename, so a Lingui macro in one of the four widget story files would extract into `src/locales/`. None imports one today, so the hole is latent, and one more reason to use `<name>.stories.tsx`.
