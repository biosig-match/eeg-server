import os
from dataclasses import dataclass


def _get_env(name: str, default: str | None = None, *, required: bool = False) -> str:
    value = os.getenv(name, default)
    if required and (value is None or not value.strip()):
        raise RuntimeError(f"Environment variable '{name}' is required and cannot be empty.")
    return value if value is not None else ""


@dataclass(frozen=True)
class Settings:
    database_url: str = _get_env("DATABASE_URL", required=True)
    bids_exporter_url: str = _get_env("BIDS_EXPORTER_URL", "http://bids_exporter:8000")
    auth_manager_url: str = _get_env("AUTH_MANAGER_URL", "http://auth_manager:3000")
    shared_volume_path: str = _get_env("SHARED_VOLUME_PATH", "/export_data")
    gemini_api_key: str = _get_env("GEMINI_API_KEY", "")


settings = Settings()
