<!--
Fill-in template for ONE confirmed finding. Copy this file, replace every
<placeholder>, delete guidance comments. Fields mirror the `Finding` type in
../scripts/lib/types.ts — see ../references/finding-schema.md.
Only fill this in AFTER a verifier sub-agent has confirmed the finding
(status: confirmed) with a reproducible signal.
-->

# <one-line title — what's wrong and where>

| field | value |
| --- | --- |
| id | `<slug, e.g. rerender-composer-chat-landing-chromium>` |
| category | `<web-vital \| unnecessary-render \| long-task \| layout-thrash \| memory-leak \| bundle \| network \| console-error \| crash \| a11y>` |
| severity | `<critical \| high \| medium \| low>` |
| confidence | `<high \| medium \| low>` |
| status | `confirmed` |
| browsers | `<chromium \| firefox \| chromium, firefox>` |
| scenario(s) | `<scenario name(s) from scripts/lib/scenarios.ts>` |
| clusterId | `<clusterId if grouped into one PR, else —>` |

## Evidence (with numbers)

<The quantitative signal that triggered and confirmed this. Include the metric,
value, unit, and threshold crossed. Examples:
- "INP=412ms (poor) on chat-landing/chromium; budget 200ms."
- "<ModelList> committed 11x during a no-op scroll, 84ms subtree render."
- "LoAF 318ms, blocking 260ms, forced layout 47ms.">

## Source attribution

`<file:line function>`  or  `<CSS selector>`

<If confirmed on Firefox via the Gecko profiler, note the hot self-time frame
and the cross-check against the Chromium LoAF entry — see
../references/gecko-profiler.md.>

## Repro command

```bash
bun scripts/run.ts --mode focus --focus <scenario> --browsers <browser>
```

<For functional/explorer findings, give the click path instead, e.g.
`/chats/new → click "Settings" → click "Devices" → click "Revoke"` — see
../references/state-exploration.md.>

## Root cause

<Why it happens, in 1–3 sentences. Name the mechanism: unstable prop/context
identity, missing memoization, synchronous layout read in a loop, oversized
eager import, unbounded listener, etc.>

## Proposed fix

<The architectural fix — not a workaround. Reference the relevant house rule or
playbook if one applies (e.g. useEffect discipline, route code-splitting).>

## Before / after

| metric | before | after | unit |
| --- | --- | --- | --- |
| <metric> | <before> | <after> | <ms \| KB \| commits \| MB \| count> |

<Populate `after` only once the fix is verified by re-running the repro command.
This row becomes the Finding.beforeAfter field and the PR's metric table — see
../assets/pr-template.md.>
