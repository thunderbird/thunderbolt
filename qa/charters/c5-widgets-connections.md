# c5-widgets-connections: widgets, files and connections

Goal: the rich parts of a reply (widgets, previews, files) and MCP connections work with a real model.

Start state: fresh user, desktop viewport. In this charter the AI is **real**: select "Opus 5"; replies vary. Keep
prompts short and send at most 12 chat messages in total.

1. Widgets, one prompt each: "What's the weather like in Berlin this weekend?", "Plot Seattle, Portland, and San
   Francisco together so I can compare their locations.", "Quiz me with one multiple-choice question about email
   protocols." (answer it), "Find me three beginner-friendly TypeScript tutorials." (open a link preview and a
   citation if shown). Check each widget renders and reacts to clicks.
2. Files: attach `qa/fixtures/sample.pdf` with `browser_file_upload`, ask about it, open it in the viewer and page
   through it.
3. Artifacts: ask for "a small HTML page with a button that counts clicks", open it and click the button.
4. MCP connection (Settings → MCP servers or Connections): add the local test server `http://127.0.0.1:9879/mcp`,
   ask the model to "echo hello with the MCP echo tool", then change its URL to port 9 and try again, then remove it.

Specs for this charter are replayed later with the fake AI ("Opus 5" always replies "Hello from the fake provider,
one word at a time."), so a spec must not depend on what a real model says. Write the finding for every bug, but
its spec only reproduces what the fake AI can show.

Out of bounds: other settings, skills, projects, account deletion. Never open the links in a new tab or navigate
away from localhost: judge a link preview by what the app shows.

Budget: about 150 tool calls.
