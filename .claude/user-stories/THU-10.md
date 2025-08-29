# Proxy "fetch content" tool to protect user privacy

Currently, when Thunderbolt fetches web pages using the fetch content tool, it does it locally. The problem is that this local fetching causes ad networks to pick up the user's IP address and learn about their searches. I've noticed this from my own experimentation.

We need to proxy all fetch content calls through our backend instead, just like we do for the search tool itself. The best approach is using Exa's get contents endpoint because they handle bot blockers like Cloudflare and manage scaling for us.

## Acceptance Criteria

Fetch Content tool is proxied to our backend using the same pattern is our other proxied endpoints (use the existing exa search endpoint for reference)

When proxying to exa, it does not forward any information that could be traced back to the user such as IP address, user-agent, or anything like that.

Unit tests are added confirming that no information is forwarded to exa.

It works as well or better than the current fetch content tool.

## Implementation Summary

✅ **Completed** - Privacy-protected fetch content tool implementation

### Changes Made

1. **New Privacy-Protected Backend (`/backend/pro/exa_content_fetcher.py`)**
   - Uses Exa's `/contents` endpoint instead of direct HTTP requests
   - Proxies all requests through Exa's infrastructure
   - Handles bot blockers and rate limiting automatically
   - Maps Exa error statuses to user-friendly messages

2. **Updated Backend Route (`/backend/pro/routes.py`)**
   - Modified `/fetch-content` endpoint to use `ExaContentFetcher`
   - Graceful fallback when Exa API key is not configured
   - Maintains same API contract for frontend compatibility

3. **Comprehensive Test Suite (`/backend/tests/test_exa_content_fetcher.py`)**
   - **Privacy Tests**: Verify no user-identifying headers sent to Exa
   - **Network Isolation Tests**: Confirm only Exa API is called, never target URLs directly
   - **Functionality Tests**: Verify error handling and content parsing
   - **Integration Tests**: Ensure endpoint works with Exa proxy

### Privacy Protection Verification

All unit tests confirm that:
- ❌ No user IP addresses are forwarded to target websites
- ❌ No User-Agent, Accept, or other identifying headers are sent
- ❌ No X-Forwarded-For or proxy headers are included
- ✅ Only the target URL and safe content parameters are sent to Exa
- ✅ All requests proxy through Exa's infrastructure

### Technical Benefits

- **Enhanced Privacy**: User IP addresses completely hidden from target sites
- **Better Reliability**: Exa handles Cloudflare and bot detection automatically  
- **Improved Performance**: Exa's optimized infrastructure for content fetching
- **Consistent Architecture**: Follows same pattern as existing Exa search tool