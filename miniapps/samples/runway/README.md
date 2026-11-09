# Sample Runway App

A Next.js **Thunderbolt Mini App**: a 24-month cash runway plan for a fictional startup (Lumen Labs, euros, January
2027 to December 2028). Ask the chat a what-if ("what if we hire two engineers in March?") and watch the chart and
headline change. It follows the structure of `samples/finance`, which documents the bridge, headers and selection
behaviour in full.

## Running

```bash
cd miniapps && bun install
cd samples/runway
bun dev          # http://localhost:5175
```

Register it with the host through a `MINI_APPS` entry whose `url` and `origin` use port 5175 (see the Finance README
for the shape and the frame-src note for the desktop app). Then enable **Settings → Preferences → Preview Features →
Mini Apps** and open **Runway Planner**.

## Environment

| Variable                              | Answers                                       | Read by                                |
| ------------------------------------- | --------------------------------------------- | -------------------------------------- |
| `NEXT_PUBLIC_THUNDERBOLT_HOST_ORIGIN` | who the app talks to, and trusts replies from | the browser, via `useThunderbolt`      |
| `THUNDERBOLT_HOST_ORIGINS`            | who is allowed to frame the app               | `next.config.ts`, as `frame-ancestors` |

Both default to the development origins. Set both when deploying.

## Tools

Each write tool returns the consequence (the new runway), so the model can iterate without re-reading context.

- `set_assumption` (`startingCash`, `monthlyRevenue`, `revenueGrowth`, `baseBurn`)
- `add_hire` (`role`, `monthlyCost`, `startMonth` as `YYYY-MM`), `remove_hire` (by `role` or `index`)
- `add_funding_round` (`label`, `amount`, `month`), `remove_funding_round` (by `label` or `index`)
- `reset_plan`

`getContext` returns the summary prose, the plan and all 24 months, and the month selected by clicking a chart point.

## Layout

```
app/page.tsx        UI and tools
app/cash-chart.tsx  the SVG chart
lib/model.ts        projection math and the model-facing summary
lib/model.test.ts   runway, break-even, funding, hires
next.config.ts      frame-ancestors, COEP/CORP
```
