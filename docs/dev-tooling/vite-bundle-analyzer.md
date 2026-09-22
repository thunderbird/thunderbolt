# Analyze Vite Modules

Thunderbolt wires [vite-bundle-analyzer](https://github.com/nonzzz/vite-bundle-analyzer) into `vite.config.ts`, but the plugin is added to the plugin list only when explicitly requested (`vite.config.ts:88-95`). It is off by default because it forces sourcemaps on for the whole build — it needs them to attribute bytes to modules — whereas a normal production build emits none unless `ENABLE_SOURCEMAP=true` (`vite.config.ts:31`).

Turn it on for a production build with an environment variable:

```sh
ANALYZE=true bun run build
```

The comparison is case-insensitive and matches only `true` (`vite.config.ts:27`). The plugin runs in `static` mode with `openAnalyzer: false`, so it writes the treemap to `dist/stats.html` and does not try to open a browser — open the file yourself. It also appends a one-line chunk-count and size summary to the end of the build output.

`package.json:27` defines an `analyze` script (`vite analyze`), but it does not produce a report: Vite's CLI has no `analyze` command, so the word is parsed as the dev-server root and `bun analyze` starts a dev server on port 5173. The plugin declares `apply: 'build'` and never runs there. Use `ANALYZE=true bun run build` instead.
