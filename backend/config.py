from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # API Keys
    fireworks_api_key: str = ""  # Make it optional with empty string default
    flower_mgmt_key: str = ""  # Flower management API key
    flower_proj_id: str = ""  # Flower project ID
    exa_api_key: str = ""  # Exa AI API key

    # Health Check Configuration
    monitoring_token: str = ""  # Secret token for health check endpoints

    # OAuth Settings
    google_client_id: str = ""  # Google OAuth client ID
    google_client_secret: str = ""  # Google OAuth client secret
    microsoft_client_id: str = ""  # Microsoft OAuth client ID (future)
    microsoft_client_secret: str = ""  # Microsoft OAuth client secret (future)

    # General settings
    log_level: str = "INFO"  # Default log level

    # Analytics settings
    posthog_host: str = "https://us.i.posthog.com"
    posthog_api_key: str = ""

    # CORS settings
    cors_origins: str = "http://localhost:1420"
    cors_origin_regex: str = ""
    cors_allow_credentials: bool = True
    cors_allow_methods: str = "GET,POST,PUT,DELETE,PATCH,OPTIONS"
    cors_allow_headers: str = "*"
    cors_expose_headers: str = "mcp-session-id"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origins_list(self) -> list[str]:
        """Convert comma-separated CORS origins string to list."""
        return [
            origin.strip() for origin in self.cors_origins.split(",") if origin.strip()
        ]

    @property
    def cors_methods_list(self) -> list[str]:
        """Convert comma-separated CORS methods string to list."""
        return [
            method.strip()
            for method in self.cors_allow_methods.split(",")
            if method.strip()
        ]


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance to avoid re-parsing env vars."""
    return Settings()
