"""
Exa AI content fetching functionality for privacy-protected web content retrieval
"""

import sys
import traceback

import httpx

from config import Settings

from .context import SimpleContext


class ExaContentFetcher:
    """Privacy-protected web content fetcher using Exa's /contents endpoint"""

    BASE_URL = "https://api.exa.ai"

    def __init__(self, api_key: str | None = None):
        settings = Settings()
        self.api_key = api_key or settings.exa_api_key
        if not self.api_key:
            raise ValueError(
                "EXA_API_KEY must be set in environment variables or .env file"
            )

    async def fetch_and_parse(self, url: str, ctx: SimpleContext) -> str:
        """
        Fetch and parse content from a webpage URL using Exa's privacy-protected endpoint.

        This method proxies the request through Exa's infrastructure, ensuring that:
        - User IP addresses are not exposed to target websites
        - No user-identifying headers are forwarded
        - Bot blockers and rate limiting are handled automatically
        """
        try:
            headers = {"x-api-key": self.api_key, "Content-Type": "application/json"}

            # Exa contents request payload - only the URL is sent to Exa
            payload = {
                "urls": [url],
                "text": {
                    "maxCharacters": 8000,  # Match current implementation's truncation
                    "includeHtmlTags": False  # Get clean markdown format
                }
            }

            await ctx.info(f"Fetching content from: {url}")

            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.BASE_URL}/contents",
                    json=payload,
                    headers=headers,
                    timeout=30.0,
                )
                response.raise_for_status()

            data = response.json()

            # Check if we have results and statuses
            results = data.get("results", [])
            statuses = data.get("statuses", [])

            # Validate the fetch was successful
            if not statuses:
                await ctx.error(f"No status information returned for URL: {url}")
                return "Error: No status information returned from content fetch service."

            status_info = statuses[0]  # We only sent one URL
            if status_info.get("status") != "success":
                error_info = status_info.get("error", {})
                error_tag = error_info.get("tag", "UNKNOWN_ERROR")
                http_status = error_info.get("httpStatusCode", "unknown")

                await ctx.error(f"Content fetch failed for {url}: {error_tag} (HTTP {http_status})")

                # Map Exa error tags to user-friendly messages
                error_messages = {
                    "CRAWL_NOT_FOUND": "Error: The webpage could not be found or accessed.",
                    "CRAWL_TIMEOUT": "Error: The request timed out while trying to fetch the webpage.",
                    "SOURCE_NOT_AVAILABLE": "Error: The webpage content is not available for fetching.",
                }
                return error_messages.get(error_tag, f"Error: Could not access the webpage ({error_tag})")

            # Extract content from the first (and only) result
            if not results:
                await ctx.error(f"No content returned for URL: {url}")
                return "Error: No content was returned from the webpage."

            result = results[0]
            content_text = result.get("text", "")

            if not content_text:
                await ctx.error(f"Empty content returned for URL: {url}")
                return "Error: The webpage returned empty content."

            await ctx.info(
                f"Successfully fetched and parsed content ({len(content_text)} characters)"
            )
            return f"Content from {url}:\n\n{content_text}"

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                await ctx.error("Invalid Exa API key")
                return "Error: Authentication failed with content fetch service."
            elif e.response.status_code == 429:
                await ctx.error("Exa API rate limit exceeded")
                return "Error: Content fetch service rate limit exceeded. Please try again later."
            else:
                await ctx.error(
                    f"Exa API error: {e.response.status_code} - {e.response.text}"
                )
                return f"Error: Content fetch service error ({e.response.status_code})"
        except httpx.TimeoutException:
            await ctx.error("Exa content fetch request timed out")
            return "Error: The request timed out while trying to fetch the webpage."
        except Exception as e:
            await ctx.error(f"Unexpected error during content fetch: {str(e)}")
            traceback.print_exc(file=sys.stderr)
            return f"Error: An unexpected error occurred while fetching the webpage ({str(e)})"
