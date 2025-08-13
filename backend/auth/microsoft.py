"""Microsoft (formerly Outlook) OAuth router.

Endpoints are namespaced under ``/auth/microsoft`` so the frontend can be
implemented immediately while backend logic is pending.
"""

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from config import Settings, get_settings

# ---------------------------------------------------------------------------
# Router & settings helpers
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/auth/microsoft", tags=["auth-microsoft"])


# ---------------------------------------------------------------------------
# Shared models
# ---------------------------------------------------------------------------


class OAuthTokenResponse(BaseModel):
    """Standard OAuth token response returned to the frontend."""

    access_token: str
    refresh_token: str | None = None
    expires_in: int
    token_type: str
    scope: str | None = None


# ---------------------------------------------------------------------------
# Request payloads
# ---------------------------------------------------------------------------


class CodeRequest(BaseModel):
    """Request body used when exchanging an authorization code."""

    code: str
    code_verifier: str
    redirect_uri: str


class RefreshRequest(BaseModel):
    """Request body for refreshing an existing Microsoft token."""

    refresh_token: str


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/config")
async def oauth_config(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Return public Microsoft OAuth configuration for the frontend."""

    return {
        "client_id": settings.microsoft_client_id,
        "configured": bool(
            settings.microsoft_client_id and settings.microsoft_client_secret
        ),
    }


# Module-level logger to namespace log output under ``auth.microsoft``.
logger = logging.getLogger(__name__)


# Constants

TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
# Must match scopes requested by the frontend (see integrations/microsoft/auth.ts)
SCOPES = "https://graph.microsoft.com/mail.read User.Read offline_access"


def _build_missing_config_error() -> HTTPException:  # pragma: no cover
    """Return a consistent HTTPException for unconfigured provider."""

    return HTTPException(
        status_code=503,
        detail=(
            "Microsoft OAuth not configured. Set MICROSOFT_CLIENT_ID and "
            "MICROSOFT_CLIENT_SECRET."
        ),
    )


@router.post("/exchange", response_model=OAuthTokenResponse)
async def exchange_code(
    body: CodeRequest, settings: Settings = Depends(get_settings)
) -> OAuthTokenResponse:
    """Exchange a Microsoft authorization code for access/refresh tokens."""

    if not settings.microsoft_client_id or not settings.microsoft_client_secret:
        raise _build_missing_config_error()

    data = {
        "client_id": settings.microsoft_client_id,
        "client_secret": settings.microsoft_client_secret,
        "code": body.code,
        "redirect_uri": body.redirect_uri,
        "grant_type": "authorization_code",
        "code_verifier": body.code_verifier,
        "scope": SCOPES,
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                TOKEN_URL,
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            response.raise_for_status()

            token_data = response.json()
            logger.info("Successfully exchanged Microsoft OAuth code for tokens")

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
            logger.error(f"Microsoft token exchange failed: {error_msg}")
            raise HTTPException(
                status_code=400, detail=f"Token exchange failed: {error_msg}"
            ) from e
        except Exception as e:  # pragma: no cover
            logger.error("Unexpected error during Microsoft token exchange: %s", str(e))
            raise HTTPException(
                status_code=500,
                detail="Internal server error during token exchange",
            ) from e


@router.post("/refresh", response_model=OAuthTokenResponse)
async def refresh_token(
    body: RefreshRequest, settings: Settings = Depends(get_settings)
) -> OAuthTokenResponse:
    """Refresh an expired Microsoft access token."""

    if not settings.microsoft_client_id or not settings.microsoft_client_secret:
        raise _build_missing_config_error()

    data = {
        "client_id": settings.microsoft_client_id,
        "client_secret": settings.microsoft_client_secret,
        "refresh_token": body.refresh_token,
        "grant_type": "refresh_token",
        "scope": SCOPES,
    }

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                TOKEN_URL,
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            response.raise_for_status()

            token_data = response.json()
            logger.info("Successfully refreshed Microsoft OAuth token")

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
            logger.error(f"Microsoft token refresh failed: {error_msg}")
            raise HTTPException(
                status_code=400, detail=f"Token refresh failed: {error_msg}"
            ) from e
        except Exception as e:  # pragma: no cover
            logger.error("Unexpected error during Microsoft token refresh: %s", str(e))
            raise HTTPException(
                status_code=500,
                detail="Internal server error during token refresh",
            ) from e
