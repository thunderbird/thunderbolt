# Frontend Structure

Where a new file goes in `src/`, and the conventions inside `src/components/ui/` that are
easy to break by accident. `@/` resolves to `src/` and `@shared/` to `shared/` in both
`tsconfig.json` and `vite.config.ts`, so every path below can be imported as `@/...`.

This page is about placement and the UI primitive layer. Code style, React patterns, i18n,
responsive sizing tokens, and route code-splitting rules live in
[AGENTS.md](../../AGENTS.md); testing conventions in [testing.md](./testing.md); Storybook
in [storybook.md](../dev-tooling/storybook.md).

## Four homes for a component

There is no single `components/` tree. A component lives in one of four places, and the
distinction is about **how many surfaces use it**, not about what it looks like.

| Home                        | Holds                                                                       | Example                                                         |
| --------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/<feature>/`            | A routed feature's pages plus the UI only that feature renders              | `src/skills/reorder-panel.tsx`, `src/projects/emoji-picker.tsx` |
| `src/components/<feature>/` | Building blocks shared across several pages or several features             | `src/components/settings/settings-list.tsx`                     |
| `src/components/ui/`        | Domain-free primitives — buttons, inputs, overlays, cards                   | `src/components/ui/button.tsx`                                  |
| `src/layout/`               | App chrome that wraps routed content: the shell, the sidebar, the main grid | `src/layout/main-layout.tsx`, `src/layout/sidebar/`             |

The decision rule, in order:

1. Used by one route only, and it knows about that feature's domain → the feature
   directory.
2. Used by two or more surfaces but still domain-aware → `src/components/<feature>/`.
3. Used across features and carries no domain knowledge → `src/components/ui/`.
4. It is chrome around the `<Outlet />` rather than content → `src/layout/`.

`src/components/settings/` is the clearest example of rule 2: `settings-list.tsx`,
`detail-field.tsx`, `icon-tile.tsx` and `detail-actions-menu.tsx` are imported from
`src/settings/`, `src/projects/`, `src/skills/` and `src/routes/settings/agents/`. They are
shared settings _furniture_, not settings _pages_.

The multi-file subfolder convention inside `src/components/` (an `index.ts` barrel exporting
only the public surface, with the feature's `use[Component]State` hook and tests alongside)
is described in [AGENTS.md](../../AGENTS.md) under React Patterns.

### Two lookalike pairs

Both pairs are load-bearing, and both read as duplicates until you know the split:

- **`src/settings/` vs `src/components/settings/`** — `src/settings/` holds the routed
  pages (`preferences.tsx`, `devices.tsx`, `models/`, `connections/`, plus `layout.tsx`).
  `src/components/settings/` holds the shared blocks those pages compose.
- **`src/chats/` vs `src/components/chat/`** — `src/chats/` is the chat _runtime_: the
  Zustand store (`chat-store.ts`), the per-thread instance (`chat-instance.ts`), scroll and
  hydration hooks, and the routed `detail.tsx`. `src/components/chat/` is the 40-odd
  components that render a conversation (message bubbles, markdown, reasoning groups, citations,
  attachments, the prompt input). See
  [chat-runtime.md](../architecture/chat-runtime.md) for how the two halves fit together.

Note what does **not** exist: there is no `src/components/skills/` or
`src/components/projects/`. Those features keep their own UI in `src/skills/` and
`src/projects/`. Adding a `src/components/<name>/` folder for a single routed feature is the
common mistake.

### Routed feature directories

The route table in [src/app.tsx](../../src/app.tsx) is the index of these. Each top-level
routed feature owns a directory: `src/chats/`, `src/settings/`, `src/tasks/`,
`src/projects/`, `src/skills/`, `src/waitlist/`, `src/routes/settings/agents/`. Features
that are not routes of their own but still own a surface follow the same shape —
`src/search/palette/` (the Cmd+K palette), `src/content-view/` (the panel beside the chat),
`src/voice/ui/`.

Whether a route ships in the entry bundle or as a lazy chunk is a separate decision with its
own rules — see the Route-level Code Splitting section of [AGENTS.md](../../AGENTS.md) and
the `routeChunkLoaders` map in `src/app.tsx`.

### Supporting layers

Feature directories sit on top of a few non-visual layers. The dependency runs one way:
components import these, and `src/dal/`, `src/lib/`, `src/hooks/` and `src/stores/` import
no components at all. The single exception is
`src/contexts/sign-in-modal-context.tsx`, which owns the modals it renders.

- `src/dal/` — Drizzle queries against the local SQLite database PowerSync manages, one
  module per table or table group. Its rules are their own page:
  [data-access-layer.md](../architecture/data-access-layer.md).
- `src/db/` — schema, PowerSync setup, seeding.
- `src/hooks/` — hooks used by more than one feature. A hook used by exactly one feature
  belongs in that feature's directory (`src/skills/use-skill-form-state.ts`,
  `src/layout/sidebar/use-sidebar-section.ts`).
- `src/contexts/` — the app-wide providers (`database`, `http-client`, `auth`,
  `sign-in-modal`), re-exported from `src/contexts/index.ts`.
- `src/stores/` — app-wide Zustand stores (`local-settings-store.ts`). A store belonging to
  one feature lives next to that feature (`src/chats/chat-store.ts`).
- `src/lib/` — framework-agnostic helpers, including `cn` in
  [src/lib/utils.ts](../../src/lib/utils.ts).

## `src/components/ui/` is vendored shadcn/ui

[components.json](../../components.json) declares the setup: shadcn/ui with the `new-york`
style, `neutral` base color, CSS variables, `lucide` icons, and `ui` aliased to
`@/components/ui`. Roughly 70 primitives live there (plus tests and stories), built on
Radix UI, `@base-ui/react`, `cmdk`, `class-variance-authority` and `tailwind-merge`.

**Treat every file in that directory as forked, not vendored-and-pristine.** The local
divergence is substantial:

- **Responsive sizing tokens.** Primitives size themselves off
  `--touch-height-*`, `--icon-size-*` and `--font-size-*` rather than fixed Tailwind
  heights — see the `size` variants in
  [src/components/ui/button.tsx](../../src/components/ui/button.tsx). Those variables swap to
  larger mobile values at 768px (see below).
- **Brand styling.** The `default` Button variant is the amber→raspberry brand gradient, with
  a `bg-origin-border` workaround documented in place.
- **Shared modal styling.** [src/components/ui/modal-styles.ts](../../src/components/ui/modal-styles.ts)
  has no upstream equivalent; overlay, close-button, surface and field-surface classes are
  centralised there so the overlay family cannot drift apart.
- **Localisation.** Primitives with visible copy use the Lingui macros, so their strings are
  in the catalogs.
- **MPL headers.** Every source file carries the MPL 2.0 short-form header, applied by
  `scripts/license-headers.ts` through the `lint-staged` pre-commit hook.
- **Haptics.** Surfaces call `useSurfaceHaptics` / mount `HapticMountBoundary`
  (`src/hooks/use-haptics.tsx`).

So `bunx shadcn@latest add <component>` over an existing file would silently drop all of
that. Use the CLI only to pull in a primitive the repo does not have yet, then re-apply the
conventions above before committing. Never re-add over a file that already exists.

## `data-slot` is a public contract

Most primitives tag their root and each named sub-part with `data-slot="<kebab-name>"` —
145 distinct values in `src/components/ui/` today. Two classes of consumer read them, and
neither produces a TypeScript error when a slot is renamed:

- **CSS descendant selectors.** `modalFieldSurfaceClass` and `panelFieldSurfaceClass` in
  `modal-styles.ts` restyle exactly four field slots — `input`, `textarea`,
  `select-trigger`, `combobox-trigger` — so form fields lift off the elevated modal and
  slide-in-panel surfaces. [src/index.css](../../src/index.css) targets slots directly too
  (`sidebar-overlay`, `create-item-layout`, `slide-in-panel`, `context-menu-trigger`).
- **Test queries.** Tests reach for structure that has no accessible name via
  `closest('[data-slot="card"]')` and `querySelector('[data-slot="dialog-content"]')` — see
  `src/settings/devices.test.tsx`, `src/settings/models/index.test.tsx`,
  `src/layout/sidebar/sidebar.test.tsx` and
  `src/layout/sidebar/rename-chat-dialog.test.tsx`, which asserts on
  `drawer-content` vs `dialog-content` to pin which half of a responsive overlay rendered.

Two consequences:

1. **Renaming a slot is a breaking change.** Grep for the value across `src/` — including
   `src/index.css` — before changing it.
2. **A new field primitive must opt in.** If it should pick up the modal/panel field
   restyle, it needs one of those four slot names, or the two constants in `modal-styles.ts`
   need a fifth entry. A new input-like primitive with a novel slot name renders on the
   wrong surface color inside a modal.

The convention is not limited to `src/components/ui/`: feature code adds slots where CSS or
tests need a handle (`data-slot="create-item-layout"` in `src/layout.tsx`,
`data-slot="new-task-input"` in `src/tasks/index.tsx`).

## The mobile/desktop split

Everything in the overlay section below branches on one model, so it comes first.

The breakpoint is **768px**, declared twice — once for CSS
(`@media (width < 768px)` in `src/index.css`) and once for JS (`mobileBreakpoint` in
[src/hooks/use-mobile.ts](../../src/hooks/use-mobile.ts)).

**The Tauri desktop app is always desktop, however narrow the window.** Its minimum window
width (`minWidth: 500` in `src-tauri/tauri.conf.json`) sits below both the 640px `sm` and
768px `md` breakpoints, so a narrow desktop window would otherwise flip to the phone layout.
Both halves of the split are overridden:

- CSS: `src/index.tsx` adds `.force-desktop` to `<html>` before first render on Tauri
  desktop. `src/index.css` redefines the `sm`, `md`, `max-sm` and `max-md` Tailwind variants
  so that class counts as "breakpoint reached", and guards the mobile `:root` token block
  with `:root:not(.force-desktop)`. `lg` and up stay purely viewport-based — they are
  wide-screen enhancements, not part of the mobile/desktop split.
- JS: `useIsMobile` returns `!isTauriDesktop() && mql().matches`, subscribed through
  `useSyncExternalStore`.

`useIsNativeMobile` is the narrower question: mobile viewport **and** the native Tauri
iOS/Android build. Use it for native-only geometry (safe areas, keyboard insets); use
`useIsMobile` for layout branching that should also apply to a narrow browser window.

Mobile overlays reserve two device insets, both defined in `src/index.css`:
`--modal-top-inset` clears the pinned corner controls, and `--modal-bottom-inset` takes
whichever of the home indicator or the software keyboard is taller. The keyboard case is why
the variable exists: the mobile modal shell is pinned at `h-dvh`, and `dvh` does not shrink
when the keyboard opens, so without giving up that space the lower half of a form sits under
the keyboard with nothing to scroll. Reserving it shrinks the content box and hands the
overflow to the inner scroller. The rationale is written out above
`getResponsiveModalSurfaceStyle` in
[src/components/ui/responsive-modal.tsx](../../src/components/ui/responsive-modal.tsx).

## Which overlay

Twelve overlapping overlay primitives, in three tiers.

**Reach for these.** They own the viewport branch, so the caller does not repeat it:

| Primitive              | Use for                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `ResponsiveModal`      | The default modal: centered dialog on desktop, full-height sheet on mobile  |
| `ConfirmActionDialog`  | Destructive confirmations — alert dialog on desktop, action sheet on mobile |
| `ResponsiveActionMenu` | An action list from a trigger: dropdown on desktop, card menu on mobile     |
| `ResponsivePopover`    | Arbitrary popover content: popover on desktop, card menu drawer on mobile   |

`ConfirmActionDialog` centralises `alertdialog` semantics, cancel-first initial focus (so a
stray Enter cannot destroy anything), and an `isPending` confirm button that a double-tap
cannot fire twice. Hand-rolling a destructive confirm loses all three.

**The halves underneath.** `Dialog` (Radix), `AlertDialog` (Radix), `Drawer`
(`@base-ui/react`, vertical only — `swipeDirection="down"` for a bottom sheet, `"up"` for a
top sheet), `Popover`, `DropdownMenu`, `MobileActionSheet` and `MobileCardMenu`. Use these
directly only when the surface is genuinely one-sided — a desktop-only dropdown, or a
mobile-only sheet.

**`Sheet`** is the Radix side sheet. Only two tests in `src/components/ui/` import it today
(`sheet.test.tsx` and `surface-haptics.test.tsx`); new slide-in surfaces use `Drawer`
(gesture-driven, CSS-animated) or `ResponsiveModal` instead.

`Drawer` wraps Base UI's Drawer, the maintained successor to vaul. Base UI animates via CSS,
so open/close transitions live in the primitive's classes (`data-starting-style` /
`data-ending-style`) rather than in JS — relevant if you are porting an animation from a
vaul-era example.

Its backdrop is deliberately lighter than `modalOverlayClass`: a card drawer is a shallow,
swipe-away surface, so it dims and blurs less than a blocking modal and sits below the
`z-50` modal layer.

## Related

- [AGENTS.md](../../AGENTS.md) — code style, React and `useEffect` rules, responsive sizing
  tokens and border-radius tiers, i18n, route code-splitting.
- [Architecture map](../architecture/README.md) — how the client fits into the wider system.
- [Testing](./testing.md) — test placement, mock isolation, what to run.
- [Storybook](../dev-tooling/storybook.md) — where stories live and how they are titled.
