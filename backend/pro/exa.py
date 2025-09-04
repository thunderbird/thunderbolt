"""
Exa AI client for neural search and privacy-protected content fetching
"""

import sys
import traceback
from dataclasses import dataclass
from typing import Any

import httpx

from config import Settings

from .context import SimpleContext


@dataclass
class ExaSearchResult:
    """
    Data structure representing a single search result from Exa's neural search.

    Attributes:
        title: The title of the webpage or document
        url: The full URL of the result
        snippet: A brief content preview (typically truncated)
        position: The ranking position in search results (1-based)
        author: The author of the content (if available)
        published_date: When the content was published (if available)
    """

    title: str
    url: str
    snippet: str
    position: int
    author: str | None = None
    published_date: str | None = None


class ExaClient:
    """
    Unified Exa AI client providing neural search and privacy-protected content fetching.

    This client handles all interactions with Exa's API endpoints, ensuring user privacy
    by proxying requests through Exa's infrastructure rather than making direct HTTP calls
    to target websites. This prevents ad networks and trackers from collecting user IP
    addresses and other identifying information.

    Supported operations:
    - Neural search using Exa's /search endpoint
    - Privacy-protected content fetching using Exa's /contents endpoint
    """

    BASE_URL = "https://api.exa.ai"

    def __init__(self, api_key: str | None = None):
        settings = Settings()
        self.api_key = api_key or settings.exa_api_key
        if not self.api_key:
            raise ValueError(
                "EXA_API_KEY must be set in environment variables or .env file"
            )

    async def search(
        self, query: str, ctx: SimpleContext, max_results: int = 10
    ) -> list[dict[str, Any]]:
        """
        Perform neural search using Exa's AI-powered search engine, using the /search endpoint.

        Args:
            query: The search query string
            ctx: Context object for logging and error reporting
            max_results: Maximum number of search results to return (default: 10)

        Returns:
            List of dictionaries containing search results with keys:
            - title: Page title
            - url: Page URL
            - snippet: Content preview (truncated to 300 chars)
            - position: Result ranking (1-based)
            - author: Page author (if available)
            - published_date: Publication date (if available)

        Raises:
            httpx.HTTPStatusError: For API authentication or rate limit errors
            httpx.TimeoutException: If the search request times out
            Exception: For other unexpected errors during search
        """
        try:
            headers = {"x-api-key": self.api_key, "Content-Type": "application/json"}

            # Exa search request payload
            payload = {
                "query": query,
                "num_results": max_results,
                "type": "auto",  # Let Exa decide between neural and keyword search
                "contents": {
                    "text": True  # Get text content for each result
                },
            }

            await ctx.info(f"Searching Exa AI for: {query}")

            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.BASE_URL}/search",
                    json=payload,
                    headers=headers,
                    timeout=30.0,
                )
                response.raise_for_status()

            data = response.json()
            results = data.get("results", [])

            await ctx.info(f"Successfully found {len(results)} results from Exa")

            # Convert to the expected format
            formatted_results = []
            for i, result in enumerate(results):
                formatted_results.append(
                    {
                        "title": result.get("title", ""),
                        "url": result.get("url", ""),
                        "snippet": result.get("text", "")[:300] + "..."
                        if result.get("text")
                        else "",
                        "position": i + 1,
                        "author": result.get("author"),
                        "published_date": result.get("published_date"),
                    }
                )

            return formatted_results

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                await ctx.error("Invalid Exa API key")
            elif e.response.status_code == 429:
                await ctx.error("Exa API rate limit exceeded")
            else:
                await ctx.error(
                    f"Exa API error: {e.response.status_code} - {e.response.text}"
                )
            return []
        except httpx.TimeoutException:
            await ctx.error("Exa search request timed out")
            return []
        except Exception as e:
            await ctx.error(f"Unexpected error during Exa search: {str(e)}")
            traceback.print_exc(file=sys.stderr)
            return []

    async def fetch_content(self, url: str, ctx: SimpleContext) -> str:
        """
        Fetch webpage content using privacy-protected proxying via Exa's /contents endpoint.

        Args:
            url: The webpage URL to fetch content from
            ctx: Context object for logging and error reporting

        Returns:
            String containing the webpage content, or an error message if fetching failed

        Raises:
            httpx.HTTPStatusError: For API authentication or rate limit errors
            httpx.TimeoutException: If the request times out
            Exception: For other unexpected errors during content fetching
        """
        try:
            headers = {"x-api-key": self.api_key, "Content-Type": "application/json"}

            # Exa contents request payload - only the URL is sent to Exa
            payload = {
                "urls": [url],
                "text": {
                    "maxCharacters": 8000,  # Match current implementation's truncation
                    "includeHtmlTags": False,  # Get clean markdown format
                },
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
                return (
                    "Error: No status information returned from content fetch service."
                )

            status_info = statuses[0]  # We only sent one URL
            if status_info.get("status") != "success":
                error_info = status_info.get("error", {})
                error_tag = error_info.get("tag", "UNKNOWN_ERROR")
                http_status = error_info.get("httpStatusCode", "unknown")

                await ctx.error(
                    f"Content fetch failed for {url}: {error_tag} (HTTP {http_status})"
                )

                # Map Exa error tags to user-friendly messages
                error_messages = {
                    "CRAWL_NOT_FOUND": "Error: The webpage could not be found or accessed.",
                    "CRAWL_TIMEOUT": "Error: The request timed out while trying to fetch the webpage.",
                    "SOURCE_NOT_AVAILABLE": "Error: The webpage content is not available for fetching.",
                }
                return error_messages.get(
                    error_tag, f"Error: Could not access the webpage ({error_tag})"
                )

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

    def format_search_results_for_llm(self, results: list[dict[str, Any]]) -> str:
        """
        Format search results for LLM consumption in natural language style.

        Args:
            results: List of search result dictionaries from the search() method

        Returns:
            Formatted string containing all search results in natural language format,
            or a "no results" message if the results list is empty
        """
        if not results:
            return "No results were found for your search query. Please try rephrasing your search."

        output = []
        output.append(f"Found {len(results)} search results from Exa AI:\n")

        for result in results:
            output.append(
                f"{result.get('position', 0)}. {result.get('title', 'No title')}"
            )
            output.append(f"   URL: {result.get('url', '')}")
            if result.get("author"):
                output.append(f"   Author: {result['author']}")
            if result.get("published_date"):
                output.append(f"   Published: {result['published_date']}")
            output.append(f"   Summary: {result.get('snippet', '')}")
            output.append("")  # Empty line between results

        return "\n".join(output)
