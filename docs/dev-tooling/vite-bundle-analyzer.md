# Analyze Vite Modules

[vite-bundle-analyzer](https://github.com/nonzzz/vite-bundle-analyzer) is wired into `vite.config.ts` but added to the plugin list only on request (`vite.config.ts:88-95`). It is off by default because it forces sourcemaps on for the whole build to attribute bytes to modules, whereas a production build emits none unless `ENABLE_SOURCEMAP=true` (`vite.config.ts:31`).

```sh
ANALYZE=true bun run build
```

| Detail | Value                                                                                                |
| ------ | ---------------------------------------------------------------------------------------------------- |
| Flag   | `ANALYZE`, case-insensitive, must equal `true` (`vite.config.ts:27`)                                 |
| Mode   | `static`, `openAnalyzer: false`                                                                      |
| Output | treemap at `dist/stats.html` (open it yourself), plus a chunk-count and size line ending the build log |

`package.json:27` defines an `analyze` script (`vite analyze`) that produces no report: Vite's CLI has no `analyze` command, so the word is parsed as the dev-server root and `bun analyze` starts a dev server on port 5173. The plugin declares `apply: 'build'` and never runs there.
