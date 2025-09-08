"""
Exa AI client wrapper for privacy-protected search and content fetching
"""

import os
from typing import Any

from exa_py import Exa

from config import Settings

from .context import SimpleContext


def create_exa_client() -> Exa | None:
    """
    Create an Exa client instance if API key is configured.

    Returns:
        Exa client instance or None if API key is not set
    """
    settings = Settings()
    api_key = settings.exa_api_key or os.getenv("EXA_API_KEY")

    if not api_key:
        return None

    return Exa(api_key=api_key)


async def search_exa(
    query: str, ctx: SimpleContext, max_results: int = 10
) -> list[dict[str, Any]]:
    """
    Search using Exa's neural search API.

    Args:
        query: Search query string
        ctx: Context for logging
        max_results: Maximum number of results to return

    Returns:
        List of search result dictionaries
    """
    client = create_exa_client()
    if not client:
        await ctx.error("Exa API key not configured")
        return []

    try:
        await ctx.info(f"Searching Exa for: {query}")

        # Use Exa's search with autoprompt for better results
        response = client.search(
            query, num_results=max_results, use_autoprompt=True, type="neural"
        )

        # Convert results to dictionary format for compatibility
        results = []
        for idx, result in enumerate(response.results, 1):
            results.append(
                {
                    "position": idx,
                    "title": result.title,
                    "url": result.url,
                    "snippet": getattr(result, "extract", "")
                    or getattr(result, "text", ""),
                    "author": getattr(result, "author", None),
                    "published_date": getattr(result, "published_date", None),
                }
            )

        await ctx.info(f"Found {len(results)} results")
        return results

    except Exception as e:
        await ctx.error(f"Exa search error: {str(e)}")
        raise


async def fetch_content_exa(url: str, ctx: SimpleContext) -> str:
    """
    Fetch content from a URL using Exa's privacy-protected proxy.

    Args:
        url: URL to fetch content from
        ctx: Context for logging

    Returns:
        Content string or error message
    """
    client = create_exa_client()
    if not client:
        return "Error: Exa API key not configured"

    try:
        await ctx.info(f"Fetching content from: {url}")

        # Use Exa's get_contents method
        response = client.get_contents(
            [url],
            text={
                "max_characters": 8000,
                "include_html_tags": False,
            },
        )

        if response.contents and len(response.contents) > 0:
            content = response.contents[0]
            # Return the text content
            return getattr(content, "text", "") or getattr(content, "extract", "")
        else:
            return "Error: No content found for the provided URL"

    except Exception as e:
        await ctx.error(f"Exa content fetch error: {str(e)}")
        return f"Error: {str(e)}"
