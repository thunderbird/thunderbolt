"""Google OAuth router and helper dataclasses.

Provides the following endpoints under the prefix ``/auth/google``:

• GET  /auth/google/config – returns the OAuth client configuration so the frontend
  can construct an authorization URL without embedding secrets.
• POST /auth/google/exchange – exchanges a Google authorization code (PKCE) for
  access/refresh tokens via the backend (which keeps the client secret secure).
• POST /auth/google/refresh – refreshes an existing Google access token.
"""

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import Settings, get_settings

router = APIRouter(prefix="/auth/google", tags=["auth-google"])


# Response model shared across providers (could be moved to a dedicated models module
# if additional providers are added later).


class OAuthTokenResponse(BaseModel):
    """Standard OAuth token response returned to the frontend."""

    access_token: str
    refresh_token: str | None = None
    expires_in: int
    token_type: str
    scope: str | None = None


# Module-level logger keeps log messages namespaced under ``auth.google``.
logger = logging.getLogger(__name__)


# Request/response payloads specific to this router ---------------------------------


class CodeRequest(BaseModel):
    """Request body used when exchanging a Google authorization code."""

    code: str
    code_verifier: str
    redirect_uri: str


class RefreshRequest(BaseModel):
    """Request body for refreshing an existing Google token."""

    refresh_token: str


@router.get("/config")
async def oauth_config(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Return public Google OAuth configuration for the frontend."""

    return {
        "client_id": settings.google_client_id,
    }


@router.post("/exchange", response_model=OAuthTokenResponse)
async def exchange_code(
    body: CodeRequest, settings: Settings = Depends(get_settings)
) -> OAuthTokenResponse:
    """Exchange a Google authorization code for access/refresh tokens."""

    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(
            status_code=503,
            detail=(
                "Google OAuth not configured. Set GOOGLE_CLIENT_ID and "
                "GOOGLE_CLIENT_SECRET."
            ),
        )

    token_url = "https://oauth2.googleapis.com/token"
    data = {
        "code": body.code,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "redirect_uri": body.redirect_uri,
        "grant_type": "authorization_code",
        "code_verifier": body.code_verifier,
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                token_url,
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            response.raise_for_status()

            token_data = response.json()
            logger.info("Successfully exchanged Google OAuth code for tokens")

            return OAuthTokenResponse(
                access_token=token_data["access_token"],
                refresh_token=token_data.get("refresh_token"),
                expires_in=token_data["expires_in"],
                token_type=token_data["token_type"],
                scope=token_data.get("scope"),
            )

        except httpx.HTTPStatusError as e:
            error_data = e.response.json() if e.response.content else {}
            error_msg = error_data.get("error_description", str(e))
            logger.error(f"Google token exchange failed: {error_msg}")
            raise HTTPException(
                status_code=400, detail=f"Token exchange failed: {error_msg}"
            ) from e
        except Exception as e:  # pragma: no cover
            logger.error("Unexpected error during Google token exchange: %s", str(e))
            raise HTTPException(
                status_code=500,
                detail="Internal server error during token exchange",
            ) from e


@router.post("/refresh", response_model=OAuthTokenResponse)
async def refresh_token(
    body: RefreshRequest, settings: Settings = Depends(get_settings)
) -> OAuthTokenResponse:
    """Refresh an expired Google access token."""

    if not settings.google_client_id or not settings.google_client_secret:
        raise HTTPException(
            status_code=503,
            detail=(
                "Google OAuth not configured. Set GOOGLE_CLIENT_ID and "
                "GOOGLE_CLIENT_SECRET."
            ),
        )

    token_url = "https://oauth2.googleapis.com/token"
    data = {
        "refresh_token": body.refresh_token,
        "client_id": settings.google_client_id,
        "client_secret": settings.google_client_secret,
        "grant_type": "refresh_token",
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                token_url,
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            response.raise_for_status()

            token_data = response.json()
            logger.info("Successfully refreshed Google OAuth token")

            return OAuthTokenResponse(
                access_token=token_data["access_token"],
                refresh_token=token_data.get("refresh_token", body.refresh_token),
                expires_in=token_data["expires_in"],
                token_type=token_data["token_type"],
                scope=token_data.get("scope"),
            )

        except httpx.HTTPStatusError as e:
            error_data = e.response.json() if e.response.content else {}
            error_msg = error_data.get("error_description", str(e))
            logger.error(f"Google token refresh failed: {error_msg}")
            raise HTTPException(
                status_code=400, detail=f"Token refresh failed: {error_msg}"
            ) from e
        except Exception as e:  # pragma: no cover
            logger.error("Unexpected error during Google token refresh: %s", str(e))
            raise HTTPException(
                status_code=500,
                detail="Internal server error during token refresh",
            ) from e
