from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    deepinfra_api_key: str

    model_config = SettingsConfigDict(env_file=".env") 