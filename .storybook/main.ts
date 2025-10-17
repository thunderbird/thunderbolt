import type { StorybookConfig } from '@storybook/react-vite'

const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    '@chromatic-com/storybook',
    '@storybook/addon-docs',
    '@storybook/addon-onboarding',
    '@storybook/addon-a11y',
    '@storybook/addon-vitest',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  async viteFinal(config) {
    // Exclude bun:sqlite from the build since it's a Bun runtime module
    // that doesn't exist in browser environments
    config.build = config.build || {}
    config.build.rollupOptions = config.build.rollupOptions || {}

    const existingExternal = config.build.rollupOptions.external
    const externalArray: (string | RegExp)[] = Array.isArray(existingExternal)
      ? existingExternal
      : existingExternal
        ? [existingExternal as string | RegExp]
        : []

    config.build.rollupOptions.external = [...externalArray, 'bun:sqlite']
    return config
  },
}
export default config
