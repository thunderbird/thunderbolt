"""
Exa AI search functionality
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
    title: str
    url: str
    snippet: str
    position: int
    author: str | None = None
    published_date: str | None = None


class ExaSearcher:
    """Exa AI searcher using their neural search API"""

    BASE_URL = "https://api.exa.ai"

    def __init__(self, api_key: str | None = None):
        settings = Settings()
        self.api_key = api_key or settings.exa_api_key
        if not self.api_key:
            raise ValueError("EXA_API_KEY must be set in environment variables or .env file")

    async def search(
        self, query: str, ctx: SimpleContext, max_results: int = 10
    ) -> list[dict[str, Any]]:
        """Search using Exa AI and return results"""
        try:
            headers = {
                "x-api-key": self.api_key,
                "Content-Type": "application/json"
            }

            # Exa search request payload
            payload = {
                "query": query,
                "num_results": max_results,
                "type": "auto",  # Let Exa decide between neural and keyword search
                "contents": {
                    "text": True  # Get text content for each result
                }
            }

            await ctx.info(f"Searching Exa AI for: {query}")

            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{self.BASE_URL}/search",
                    json=payload,
                    headers=headers,
                    timeout=30.0
                )
                response.raise_for_status()

            data = response.json()
            results = data.get("results", [])

            await ctx.info(f"Successfully found {len(results)} results from Exa")

            # Convert to the expected format
            formatted_results = []
            for i, result in enumerate(results):
                formatted_results.append({
                    "title": result.get("title", ""),
                    "url": result.get("url", ""),
                    "snippet": result.get("text", "")[:300] + "..." if result.get("text") else "",
                    "position": i + 1,
                    "author": result.get("author"),
                    "published_date": result.get("published_date")
                })

            return formatted_results

        except httpx.HTTPStatusError as e:
            if e.response.status_code == 401:
                await ctx.error("Invalid Exa API key")
            elif e.response.status_code == 429:
                await ctx.error("Exa API rate limit exceeded")
            else:
                await ctx.error(f"Exa API error: {e.response.status_code} - {e.response.text}")
            return []
        except httpx.TimeoutException:
            await ctx.error("Exa search request timed out")
            return []
        except Exception as e:
            await ctx.error(f"Unexpected error during Exa search: {str(e)}")
            traceback.print_exc(file=sys.stderr)
            return []

    def format_results_for_llm(self, results: list[dict[str, Any]]) -> str:
        """Format results in a natural language style that's easier for LLMs to process"""
        if not results:
            return "No results were found for your search query. Please try rephrasing your search."

        output = []
        output.append(f"Found {len(results)} search results from Exa AI:\n")

        for result in results:
            output.append(f"{result.get('position', 0)}. {result.get('title', 'No title')}")
            output.append(f"   URL: {result.get('url', '')}")
            if result.get('author'):
                output.append(f"   Author: {result['author']}")
            if result.get('published_date'):
                output.append(f"   Published: {result['published_date']}")
            output.append(f"   Summary: {result.get('snippet', '')}")
            output.append("")  # Empty line between results

        return "\n".join(output)
