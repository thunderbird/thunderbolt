# Browser playground

Small, local websites for exercising Thunderbolt's browser tools and visible cursor. No login, backend, external assets, or network services are needed. All form and game state stays in memory; reloading resets it.

From the repository root:

```sh
bun run dev:browser-playground
```

Open **http://127.0.0.1:4174/** in the desktop browser. The server binds only to loopback. Set `BROWSER_PLAYGROUND_PORT` to use another port.

| Page                 | What to try                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/minesweeper.html`  | Reveal squares, right-click or use Flag mode, press F to flag a focused square, reset, win/lose. Seed 42 is the default. The same seed **and first reveal** reproduce the board; the first square and its neighbors are safe.               |
| `/sudoku.html`       | Type digits, navigate with arrows, use the number pad, erase, check mistakes, reset, complete the fixed puzzle. Each cell has a row/column label.                                                                                           |
| `/interactions.html` | Type Unicode and multiline text, use Tab/Enter, choose options, toggle checkboxes, submit, open/dismiss a modal, scroll to a checkpoint. The journal reports trusted native versus script-dispatched events without logging field contents. |

Example prompts:

- “Open http://127.0.0.1:4174/minesweeper.html and play a game. Start at row 1, column 1.”
- “Solve the first row of the Sudoku at http://127.0.0.1:4174/sudoku.html.”
- “Open the interaction lab. Reserve a photography workshop for Jamie, jamie@example.com, with three guests. Add ‘café ✓’ as the note, submit, and collect the checkpoint.”

These are ordinary web pages with no Tauri bridge, privileged testing API, or agent instructions hidden in the page. The games intentionally use DOM controls so both element references and screenshot coordinates can be exercised.

Run the standalone browser check (uses the repository's installed Chrome for Testing):

```sh
bun e2e/browser-playground/verify.ts
```

It starts a temporary server, checks both game outcomes, Sudoku editing/validation, real input and form events, modal/scroll interactions, and all pages at a narrow viewport, then closes its browser and server.
