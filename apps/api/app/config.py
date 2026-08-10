"""Application configuration.

Centralized, typed settings loaded from environment variables / `.env`.
This is the single source of truth for runtime configuration — no module
in the codebase should read `os.environ` directly.
"""

from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Typed application settings.

    Values are sourced from environment variables first, falling back to a
    local `.env` file when present (development convenience only — in
    staging/production, real environment variables must be injected by the
    deployment platform).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Application ---
    app_name: str = "JOE Knowledge Platform"
    app_env: Literal["development", "staging", "production", "test"] = "development"
    app_version: str = "0.1.0"
    api_prefix: str = "/v1"
    debug: bool = True
    log_level: str = "INFO"

    # --- Server ---
    host: str = "0.0.0.0"
    port: int = 8000

    # --- Database ---
    database_url: str = Field(
        default="postgresql+asyncpg://joe:joe@localhost:5432/joe_knowledge_platform"
    )

    # --- Redis ---
    redis_url: str = "redis://localhost:6379/0"

    # --- RabbitMQ ---
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672//"

    # --- MinIO ---
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "joe_minio_access"
    minio_secret_key: str = "change_me"
    minio_bucket: str = "jkp-datasets"

    # --- Auth ---
    jwt_secret_key: str = "insecure-dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 30
    jwt_refresh_token_expire_days: int = 7

    # --- CORS ---
    cors_allowed_origins: str = "http://localhost:3000"

    @property
    def cors_origins_list(self) -> list[str]:
        """Parse the comma-separated CORS origins string into a list."""
        return [origin.strip() for origin in self.cors_allowed_origins.split(",") if origin.strip()]

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"


@lru_cache
def get_settings() -> Settings:
    """Return a cached Settings instance.

    `lru_cache` ensures we parse the environment once per process and reuse
    it everywhere via FastAPI's dependency injection.
    """
    return Settings()
