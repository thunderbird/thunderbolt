import json
import logging
import time
from datetime import UTC, datetime

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse

import config
from config import Settings
from flower_auth import get_flower_api_key
from request_utils import build_user_id_hash


def get_settings() -> Settings:
    """Return current Settings via central config getter.

    Wrapper ensures tests can patch either healthcheck.get_settings or
    config.get_settings and still affect call sites.
    """
    return config.get_settings()


# Constants
FLOWER_CHAT_COMPLETIONS_URL = "https://api.flower.ai/v1/chat/completions"
HEALTHCHECK_USER_AGENT = "Thunderbolt-HealthCheck/1.0"


def utc_now() -> str:
    """Return current UTC time as RFC3339 with a trailing Z."""
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


# Health check configurations for different models
HEALTH_CHECK_CONFIGS = {
    "qwen/qwen3-235b": {
        "prompt": 'Hello, this is a healthcheck, please respond with the exact string "Healthcheck confirmed."',
        "expected_response": "Healthcheck confirmed.",
        "timeout": 15.0,
    },
    # Add more models here as needed
}

# Default health check configuration for any model not specifically configured
DEFAULT_HEALTH_CHECK_CONFIG = {
    "prompt": 'Hello, this is a healthcheck, please respond with the exact string "Healthcheck confirmed."',
    "expected_response": "Healthcheck confirmed.",
    "timeout": 15.0,
}

router = APIRouter(prefix="/healthcheck", tags=["healthcheck"])


async def validate_monitoring_token(token: str = Query(..., alias="token")) -> None:
    """Validate the monitoring token from query parameters.

    Args:
        token: The monitoring token provided as a query parameter

    Raises:
        HTTPException: If token is invalid or health checks not configured
    """
    settings = get_settings()
    if not settings.monitoring_token:
        raise HTTPException(status_code=503, detail="Health check not configured")

    if token != settings.monitoring_token:
        raise HTTPException(status_code=401, detail="Invalid monitoring token")


def _success_response(
    *, model: str, service: str, timestamp: str, latency_ms: float, response: str
) -> JSONResponse:
    return JSONResponse(
        status_code=200,
        content={
            "ok": True,
            "model": model,
            "service": service,
            "latency_ms": latency_ms,
            "timestamp": timestamp,
            "response": response,
            "error": None,
        },
    )


def _error_response(
    *,
    status_code: int,
    model: str,
    service: str,
    timestamp: str,
    latency_ms: float,
    error: str,
    response: str | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "ok": False,
            "model": model,
            "service": service,
            "latency_ms": latency_ms,
            "timestamp": timestamp,
            "error": error,
            "response": response,
        },
    )


async def collect_streamed_content(response: httpx.Response) -> str:
    """Collect content from a streaming-like response into a single string.

    Accepts Flower-style SSE payloads and variants that may not prefix with data:.
    """
    collected_content = ""
    async for line in response.aiter_lines():
        if not line:
            continue

        if line.startswith("data: "):
            data_str = line[6:]
        elif line.startswith("data:"):
            data_str = line[5:]
        else:
            data_str = line

        data_str = data_str.strip()
        if not data_str or data_str == "[DONE]":
            if data_str == "[DONE]":
                break
            continue

        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            continue

        if "choices" not in data or not data["choices"]:
            continue

        choice = data["choices"][0]
        delta = choice.get("delta", {})
        content = delta.get("content", "")

        if not content and "text" in choice:
            content = choice["text"]

        if not content and "message" in choice:
            message = choice["message"]
            content = message.get("content", "")

        if content:
            collected_content += content

    return collected_content


@router.get("/flower/{model:path}")
async def health_check_flower_model(
    model: str,
    request: Request,
    _: None = Depends(validate_monitoring_token),
) -> JSONResponse:
    """Health check endpoint for Flower AI models with streaming validation.

    Makes a streaming request to the Flower AI service and validates that the response
    matches exactly what we expect. This enables monitoring services like Betterstack
    to track latency, uptime, and service health.

    Args:
        model: The model name to test (e.g., "qwen3")
        request: FastAPI request object
        _: Validated monitoring token dependency

    Returns:
        JSONResponse with health check results including latency and validation status
    """
    logger = logging.getLogger(__name__)
    start_time = time.time()
    timestamp = utc_now()
    settings = get_settings()

    # Get model configuration (use default if not specifically configured)
    model_config = HEALTH_CHECK_CONFIGS.get(model, DEFAULT_HEALTH_CHECK_CONFIG)

    # Early return if Flower AI not configured
    if not settings.flower_mgmt_key or not settings.flower_proj_id:
        latency_ms = round((time.time() - start_time) * 1000, 2)
        return _error_response(
            status_code=503,
            model=model,
            service="flower",
            timestamp=timestamp,
            latency_ms=latency_ms,
            error="Flower AI not configured",
            response=None,
        )

    try:
        # Get Flower API key using existing auth system
        user_id_hash = build_user_id_hash(request)

        api_key = get_flower_api_key(user_id_hash, settings=settings)

        # Build the request payload
        payload = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": model_config["prompt"],
                }
            ],
            "stream": True,
            "max_tokens": 50,
            "temperature": 0.0,  # Deterministic responses for reliable testing
        }

        # Make streaming request to Flower AI
        target_url = FLOWER_CHAT_COMPLETIONS_URL
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": HEALTHCHECK_USER_AGENT,
        }

        async with httpx.AsyncClient(timeout=model_config["timeout"]) as client:
            response = await client.post(
                target_url,
                headers=headers,
                json=payload,
                timeout=model_config["timeout"],
            )
            response.raise_for_status()

            collected_content = await collect_streamed_content(response)

            # Calculate final latency
            latency_ms = round((time.time() - start_time) * 1000, 2)

            # Validate response matches exactly what we expect
            expected = model_config["expected_response"]
            actual = collected_content.strip()

            if actual == expected:
                return _success_response(
                    model=model,
                    service="flower",
                    latency_ms=latency_ms,
                    timestamp=timestamp,
                    response=actual,
                )
            return _error_response(
                status_code=503,
                model=model,
                service="flower",
                latency_ms=latency_ms,
                timestamp=timestamp,
                error=f"Response mismatch: expected '{expected}' but got '{actual}'",
                response=actual,
            )

    except httpx.TimeoutException:
        latency_ms = round((time.time() - start_time) * 1000, 2)
        logger.error(f"Health check timeout for {model}")
        return _error_response(
            status_code=503,
            model=model,
            service="flower",
            latency_ms=latency_ms,
            timestamp=timestamp,
            error=f"Request timeout after {model_config['timeout']}s",
            response=None,
        )
    except httpx.HTTPStatusError as e:
        latency_ms = round((time.time() - start_time) * 1000, 2)
        logger.error(f"Health check HTTP error for {model}: {e.response.status_code}")

        # Handle model not allowed errors specifically
        error_message = f"HTTP {e.response.status_code}: {e.response.text}"
        try:
            error_data = e.response.json()
            if "detail" in error_data:
                detail = error_data["detail"]
                if isinstance(detail, dict) and detail.get("code") == "40001":
                    error_message = f"Model '{model}' is not available in your Flower AI project. Please check your project configuration or use a different model name."
                elif isinstance(detail, str):
                    error_message = detail
        except Exception:
            pass

        return _error_response(
            status_code=503,
            model=model,
            service="flower",
            latency_ms=latency_ms,
            timestamp=timestamp,
            error=error_message,
            response=None,
        )
    except Exception as e:
        latency_ms = round((time.time() - start_time) * 1000, 2)
        logger.error(f"Health check failed for {model}: {str(e)}", exc_info=True)
        return _error_response(
            status_code=503,
            model=model,
            service="flower",
            latency_ms=latency_ms,
            timestamp=timestamp,
            error=str(e),
            response=None,
        )


@router.get("/status")
async def health_check_status(
    _: None = Depends(validate_monitoring_token),
) -> JSONResponse:
    """Get the status of available health check endpoints.

    Returns information about which models and services are configured
    for health checking.

    Args:
        _: Validated monitoring token dependency

    Returns:
        JSONResponse with available health check configurations
    """
    settings = get_settings()

    # Check service availability
    services = {
        "flower": {
            "available": bool(settings.flower_mgmt_key and settings.flower_proj_id),
            "models": list(HEALTH_CHECK_CONFIGS.keys())
            if settings.flower_mgmt_key and settings.flower_proj_id
            else [],
        }
    }

    return JSONResponse(
        status_code=200,
        content={
            "timestamp": utc_now(),
            "services": services,
            "total_endpoints": sum(
                len(service["models"]) for service in services.values()
            ),
        },
    )
