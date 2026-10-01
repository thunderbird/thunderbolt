# c5-widgets-connections: widgets, files and connections

Goal: the rich parts of a reply (widgets, previews, files), MCP connections and project instructions work with a
real model.

Start state: fresh user, desktop viewport. In this charter the AI is **real**: select "Opus 5"; replies vary. Keep
prompts short and send at most 12 chat messages in total. Read every reply and check the AI did the task: a reply
saying a tool, a search, the file or the MCP server failed is a finding (`ai-reported-failure`).

1. Widgets, one prompt each: "What's the weather like in Berlin this weekend?", "Plot Seattle, Portland, and San
   Francisco together so I can compare their locations.", "Quiz me with one multiple-choice question about email
   protocols." (answer it), "Find me three beginner-friendly TypeScript tutorials." (open a link preview and a
   citation if shown). Check each widget renders and reacts to clicks. Functions: `weather-widget`, `map-widget`,
   `quiz-widget`, `search-sources`.
2. Files: attach `.github/qa/fixtures/sample.pdf` with `browser_file_upload`, ask what it says, and open it in the
   viewer. The reply must state the file's real content. Function: `pdf-read`.
3. Artifacts: ask for "a small HTML page with a button that counts clicks", open it and click the button.
   Function: `html-artifact`.
4. MCP connection (Settings → MCP servers or Connections): add the local test server `http://127.0.0.1:9879/mcp`, ask
   the model to echo a fresh word of yours with the MCP echo tool and check the tool really ran, then change its URL
   to port 9 and try again, then remove it. A failure on port 9 is expected, because you broke the URL on purpose.
   Functions: `mcp-echo`, `mcp-broken-url`, `mcp-remove`.
5. Project instructions: create a project whose instructions set a clear, checkable rule (for example "End every
   reply with the word BANANA"), start a chat in it and send a short prompt. Function: `project-instructions-reply`.

Specs for this charter replay against the same real providers, three times each, and two failures confirm a
finding. A spec may depend on what the model does (it called the tool, the widget rendered), never on its exact
words.

Out of bounds: other settings, skills, project management beyond step 5, account deletion. Integrations (Google,
Microsoft) are not covered by any charter. Never open the links in a new tab or navigate away from localhost: judge
a link preview by what the app shows.
