# c5-widgets-connections: widgets, files and connections

Target: the rich parts of a real model's reply (widgets, sources, files, artifacts), MCP connections, and project
instructions shaping a real reply.
Risks: a widget that does not render or react, an answer about a file or tool that is wrong or invented, a tool that
never really runs, a broken connection that hangs the chat, instructions the model never receives.
Start state: fresh user, desktop viewport. The AI is **real**: select "Opus 5"; replies vary. Keep prompts short and
send at most 12 chat messages in total.
Specs for this mission replay against the same real providers, three times each, and two failures confirm a finding.
A spec may depend on what the model does (it called the tool, the widget rendered), never on its exact words.
Out of bounds: other settings, skills, project management beyond what `project-instructions-reply` needs, account
deletion; integrations (Google, Microsoft) are not covered by any mission. Never open a link in a new tab or leave
localhost: judge a link preview by what the app shows.
