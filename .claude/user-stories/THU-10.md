# Proxy "fetch content" tool to protect user privacy

Currently, when Thunderbolt fetches web pages using the fetch content tool, it does it locally. The problem is that this local fetching causes ad networks to pick up the user's IP address and learn about their searches. I've noticed this from my own experimentation.

We need to proxy all fetch content calls through our backend instead, just like we do for the search tool itself. The best approach is using Exa's get contents endpoint because they handle bot blockers like Cloudflare and manage scaling for us.

## Acceptance Criteria

Fetch Content tool is proxied to our backend using the same pattern is our other proxied endpoints (use the existing exa search endpoint for reference)

When proxying to exa, it does not forward any information that could be traced back to the user such as IP address, user-agent, or anything like that.

Unit tests are added confirming that no information is forwarded to exa.

It works as well or better than the current fetch content tool.