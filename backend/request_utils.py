from fastapi import Request


def build_user_id_hash(request: Request, fallback: str = "unknown") -> str:
    """Build a stable user identifier from request metadata.

    Uses the User-Agent and client IP to produce a simple, stable identifier
    that can be used for per-user billing or rate limiting contexts.
    """

    user_agent = request.headers.get("user-agent", fallback)
    client_ip = fallback
    if request.client is not None:
        client_ip = getattr(request.client, "host", fallback)
    return f"{user_agent}:{client_ip}"
