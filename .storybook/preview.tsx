/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import type { Preview } from '@storybook/react-vite'
import { withThemeByClassName } from '@storybook/addon-themes'
import { domMax, LazyMotion } from 'framer-motion'
import { ThemedDocsContainer } from './themed-docs-container'
import '../src/index.css'
import './preview.css'

const preview: Preview = {
  decorators: [
    // The app wraps everything in LazyMotion (src/app.tsx), and `m.*`
    // components silently never animate without it — stories using
    // `initial={{ scale: 0 }}` etc. would render invisible at their initial
    // pose. Mirror the app wrapper globally so every story gets working
    // motion. (Bundle size doesn't matter here, so features load eagerly.)
    (Story) => (
      <LazyMotion features={domMax} strict>
        <Story />
      </LazyMotion>
    ),
    // Light/dark toolbar toggle (paintbrush icon). Mirrors the app's
    // ThemeProvider, which drives dark mode via a `dark` class on <html> —
    // index.css's `@variant dark` and the body background both key off it.
    withThemeByClassName({
      themes: {
        light: '',
        dark: 'dark',
      },
      defaultTheme: 'light',
    }),
  ],

  // Icon-only theme toolbar. The addon-themes manager UI renders a
  // "light theme/dark theme" text label with no way to hide it, so the addon
  // is not registered in main.ts — only its decorator (above) is used. This
  // globalType drives the same `theme` global the decorator reads, and the
  // core toolbar renders icon-only when items have titles but dynamicTitle
  // is off.
  globalTypes: {
    theme: {
      description: 'Theme',
      toolbar: {
        icon: 'paintbrush',
        preventDynamicIcon: true,
        items: [
          { value: 'light', icon: 'sun', title: 'Light' },
          { value: 'dark', icon: 'moon', title: 'Dark' },
        ],
        dynamicTitle: false,
      },
    },
  },

  initialGlobals: {
    theme: 'light',
  },

  parameters: {
    // Follows the theme toolbar toggle — see ThemedDocsContainer for why
    // docs pages need their own theme handling.
    docs: {
      container: ThemedDocsContainer,
    },

    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },

    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: 'todo',
    },
  },
}

export default preview
