# Analyze Vite Modules

Thunderbolt ships with [vite-bundle-analyzer](https://github.com/victorb/vite-plugin-bundle-analyzer) wired in, but **it is disabled by default** so it doesn't slow down normal builds or break CI on missing `stats.html`.

There are two ways to turn it on:

1. Run the dedicated script (convenient for local use):

   ```sh
   bun analyze   # alias for `vite analyze`
   ```

2. Toggle it for any build by setting an environment variable (handy in CI):

   ```sh
   ANALYZE=true bun run build   # generates dist/stats.html alongside a normal production build
   ```

In both cases the plugin runs in _static_ mode and writes `dist/stats.html`; it will **not** try to open a browser automatically.
