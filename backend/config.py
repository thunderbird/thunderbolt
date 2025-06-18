from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # API Keys
    fireworks_api_key: str = ""  # Make it optional with empty string default
    flower_mgmt_key: str = ""  # Flower management API key
    flower_proj_id: str = ""  # Flower project ID

    # General settings
    log_level: str = "INFO"  # Default log level

    # CORS settings
    cors_origins: str = "http://localhost:1420"
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
