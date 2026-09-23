# Frontend Structure

Where a new file goes in `src/`, and the `src/components/ui/` conventions that are easy to
break. `@/` resolves to `src/` and `@shared/` to `shared/` in both `tsconfig.json` and
`vite.config.ts`.

## Where does a component go?

There is no single `components/` tree; placement follows **how many surfaces use it**, not
what it looks like.

| Home                        | Holds                                                    | Example                                                         |
| --------------------------- | -------------------------------------------------------- | --------------------------------------------------------------- |
| `src/<feature>/`            | A routed feature's pages and its own UI                  | `src/skills/reorder-panel.tsx`, `src/projects/emoji-picker.tsx` |
| `src/components/<feature>/` | Blocks shared across several pages or features           | `src/components/settings/settings-list.tsx`                     |
| `src/components/ui/`        | Domain-free primitives: buttons, inputs, overlays, cards | `src/components/ui/button.tsx`                                  |
| `src/layout/`               | Chrome wrapping routed content: shell, sidebar, grid     | `src/layout/main-layout.tsx`, `src/layout/sidebar/`             |

The decision rule, in order:

1. One route only, knows that feature's domain → the feature directory.
2. Two or more surfaces, still domain-aware → `src/components/<feature>/`.
3. Across features, no domain knowledge → `src/components/ui/`.
4. Chrome around the `<Outlet />` rather than content → `src/layout/`.

Rule 2 example: `settings-list.tsx`, `detail-field.tsx`, `icon-tile.tsx` and
`detail-actions-menu.tsx` are imported by `src/settings/`, `src/projects/`, `src/skills/`
and `src/routes/settings/agents/`.

Multi-file subfolders in `src/components/` take an `index.ts` barrel plus the
`use[Component]State` hook and tests ([AGENTS.md](../../AGENTS.md), React Patterns).

### Two pairs that look like duplicates

| Directory                  | Holds                                                                                                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/settings/`            | Routed pages: `preferences.tsx`, `devices.tsx`, `models/`, `connections/`, `layout.tsx`                                                                                     |
| `src/components/settings/` | The shared blocks those pages compose                                                                                                                                       |
| `src/chats/`               | Chat _runtime_: `chat-store.ts` (Zustand), `chat-instance.ts` (per thread), scroll/hydration hooks, routed `detail.tsx`. [chat-runtime.md](../architecture/chat-runtime.md) |
| `src/components/chat/`     | The 40-odd components rendering a conversation: bubbles, markdown, reasoning groups, citations, attachments, prompt input                                                   |

Adding a `src/components/<name>/` folder for a single routed feature is the common mistake:
there is no `src/components/skills/` or `src/components/projects/`.

### Which directories are routed features?

The route table in [src/app.tsx](../../src/app.tsx) is the index: `src/chats/`,
`src/settings/`, `src/tasks/`, `src/projects/`, `src/skills/`, `src/waitlist/`,
`src/routes/settings/agents/`. Non-route surfaces follow the same shape:
`src/search/palette/` (Cmd+K), `src/content-view/` (panel beside the chat), `src/voice/ui/`.

Entry bundle vs lazy chunk: see Route-level Code Splitting in [AGENTS.md](../../AGENTS.md)
and `routeChunkLoaders` in `src/app.tsx`.

### Where does non-visual code go?

| Layer           | Holds                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/dal/`      | Drizzle queries against the local PowerSync-managed SQLite, one module per table or group. [data-access-layer.md](../architecture/data-access-layer.md) |
| `src/db/`       | Schema, PowerSync setup, seeding                                                                                                                        |
| `src/hooks/`    | Cross-feature hooks. Single-feature hooks live with the feature (`src/skills/use-skill-form-state.ts`, `src/layout/sidebar/use-sidebar-section.ts`)     |
| `src/contexts/` | App-wide providers (`database`, `http-client`, `auth`, `sign-in-modal`), re-exported from `src/contexts/index.ts`                                       |
| `src/stores/`   | App-wide Zustand stores (`local-settings-store.ts`). A feature's own store lives next to it (`src/chats/chat-store.ts`)                                 |
| `src/lib/`      | Framework-agnostic helpers, including `cn` in [src/lib/utils.ts](../../src/lib/utils.ts)                                                                |

Dependencies run one way: components import these layers; `src/dal/`, `src/lib/`,
`src/hooks/` and `src/stores/` import no components. Exception:
`src/contexts/sign-in-modal-context.tsx`, which owns the modals it renders.

## `src/components/ui/` is forked shadcn/ui

**Treat every file there as forked, not vendored-and-pristine.** Running
`bunx shadcn@latest add <component>` over an existing file silently drops the divergences
below. Use the CLI only for a primitive the repo lacks, then re-apply these conventions.

| Divergence               | What it means                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Responsive sizing tokens | Primitives size off `--touch-height-*`, `--icon-size-*`, `--font-size-*`, not fixed Tailwind heights (see the `size` variants in [button.tsx](../../src/components/ui/button.tsx)). Those swap to mobile values at 768px |
| Brand styling            | The `default` Button variant is the amber→raspberry brand gradient, with a `bg-origin-border` workaround documented in place                                                                                             |
| Shared modal styling     | [modal-styles.ts](../../src/components/ui/modal-styles.ts) has no upstream equivalent. Overlay, close-button, surface and field-surface classes are centralised so the overlay family cannot drift apart                 |
| Localisation             | Primitives with visible copy use the Lingui macros, so their strings reach the catalogs                                                                                                                                  |
| MPL headers              | Every file carries the MPL 2.0 short-form header, applied by `scripts/license-headers.ts` via the `lint-staged` pre-commit hook                                                                                          |
| Haptics                  | Surfaces call `useSurfaceHaptics` / mount `HapticMountBoundary` (`src/hooks/use-haptics.tsx`)                                                                                                                            |

[components.json](../../components.json) declares the setup: `new-york` style, `neutral` base
color, CSS variables, `lucide` icons, `ui` aliased to `@/components/ui`. Roughly 70 primitives
(plus tests and stories), on Radix UI, `@base-ui/react`, `cmdk`, `class-variance-authority` and
`tailwind-merge`.

## `data-slot` is a public contract

Most primitives tag their root and each named sub-part with `data-slot="<kebab-name>"`, 145
distinct values today.

1. **Renaming a slot is a breaking change.** Grep the value across `src/`, including
   `src/index.css`, first.
2. **A new field primitive must opt in.** It needs one of the four field slot names below, or
   a fifth entry in the two `modal-styles.ts` constants. A novel name renders on the wrong
   surface color in a modal.

Two consumers read slots, and neither errors in TypeScript when one is renamed:

- **CSS descendant selectors.** `modalFieldSurfaceClass` and `panelFieldSurfaceClass`
  (`modal-styles.ts`) restyle exactly four slots (`input`, `textarea`, `select-trigger`,
  `combobox-trigger`) so fields lift off modal and panel surfaces.
  [src/index.css](../../src/index.css) also targets `sidebar-overlay`, `create-item-layout`,
  `slide-in-panel`, `context-menu-trigger`.
- **Test queries.** `closest('[data-slot="card"]')`,
  `querySelector('[data-slot="dialog-content"]')` in `src/settings/devices.test.tsx`,
  `src/settings/models/index.test.tsx`, `src/layout/sidebar/sidebar.test.tsx`, and
  `src/layout/sidebar/rename-chat-dialog.test.tsx`, which asserts `drawer-content` vs
  `dialog-content` to pin which half of a responsive overlay rendered.

Feature code adds slots too: `data-slot="create-item-layout"` in `src/layout.tsx`,
`data-slot="new-task-input"` in `src/tasks/index.tsx`.

## Mobile or desktop?

The breakpoint is **768px**, declared twice: `@media (width < 768px)` in `src/index.css`, and
`mobileBreakpoint` in [src/hooks/use-mobile.ts](../../src/hooks/use-mobile.ts).

| Hook                | True when                                                        | Use for                                                            |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| `useIsMobile`       | `!isTauriDesktop() && mql().matches`, via `useSyncExternalStore` | Layout branching that should also apply to a narrow browser window |
| `useIsNativeMobile` | Mobile viewport **and** the native Tauri iOS/Android build       | Native-only geometry (safe areas, keyboard insets)                 |

**The Tauri desktop app is always desktop, however narrow the window.** Its `minWidth: 500`
(`src-tauri/tauri.conf.json`) is below both the 640px `sm` and 768px `md` breakpoints, so a
narrow window would otherwise flip to the phone layout. Both halves are overridden:

- **CSS**: `src/index.tsx` adds `.force-desktop` to `<html>` before first render on Tauri
  desktop. `src/index.css` redefines the `sm`, `md`, `max-sm`, `max-md` variants so that
  class counts as "breakpoint reached", and guards the mobile `:root` token block with
  `:root:not(.force-desktop)`. `lg` and up stay viewport-based, outside this split.
- **JS**: `useIsMobile`, above.

Mobile overlays reserve two insets from `src/index.css`. `--modal-top-inset` clears the
pinned corner controls. `--modal-bottom-inset` takes whichever of the home indicator or
software keyboard is taller, because the modal shell is pinned at `h-dvh` and `dvh` does not
shrink when the keyboard opens: unreserved, the lower half of a form sits under the keyboard
with nothing to scroll. Reserving it hands the overflow to the inner scroller. See
`getResponsiveModalSurfaceStyle` in
[responsive-modal.tsx](../../src/components/ui/responsive-modal.tsx).

## Which overlay primitive?

Twelve overlapping primitives, in three tiers.

**Reach for these.** They own the viewport branch, so callers need not:

| Primitive              | Use for                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `ResponsiveModal`      | The default modal: centered dialog on desktop, full-height sheet on mobile |
| `ConfirmActionDialog`  | Destructive confirmations: alert dialog on desktop, action sheet on mobile |
| `ResponsiveActionMenu` | Action list from a trigger: dropdown on desktop, card menu on mobile       |
| `ResponsivePopover`    | Arbitrary popover content: popover on desktop, card menu drawer on mobile  |

`ConfirmActionDialog` centralises three things a hand-rolled confirm loses: `alertdialog`
semantics, cancel-first initial focus (a stray Enter cannot destroy anything), and an
`isPending` confirm button a double-tap cannot fire twice.

**The halves underneath**, for genuinely one-sided surfaces only:

- `Dialog`, `AlertDialog` (Radix)
- `Drawer` (`@base-ui/react`), vertical only: `swipeDirection="down"` for a bottom sheet,
  `"up"` for a top sheet
- `Popover`, `DropdownMenu`
- `MobileActionSheet`, `MobileCardMenu`

`Drawer` wraps Base UI's Drawer, the maintained successor to vaul. Base UI animates via CSS,
so transitions live in the primitive's classes (`data-starting-style` / `data-ending-style`)
rather than in JS, relevant when porting a vaul-era animation. Its backdrop deliberately dims
and blurs less than `modalOverlayClass`, and sits below the `z-50` modal layer: a card
drawer is shallow and swipe-away, not blocking.

**`Sheet`** is the Radix side sheet, imported today only by two tests in
`src/components/ui/` (`sheet.test.tsx`, `surface-haptics.test.tsx`); new slide-in surfaces
use `Drawer` or `ResponsiveModal`.

## Related

- [AGENTS.md](../../AGENTS.md): code style, React and `useEffect` rules, sizing tokens,
  border-radius tiers, i18n, route code-splitting.
- [Architecture map](../architecture/README.md): how the client fits the wider system.
- [Testing](./testing.md): test placement, mock isolation, what to run.
- [Storybook](../dev-tooling/storybook.md): where stories live and how they are titled.
