from dataclasses import dataclass
import os


def _get_env(name: str, default: str | None = None, *, required: bool = False) -> str:
  value = os.getenv(name, default)
  if required and (value is None or value == ""):
    raise RuntimeError(f"Environment variable '{name}' is required")
  if value is None:
    raise RuntimeError(f"Environment variable '{name}' is required")
  return value


@dataclass(frozen=True)
class Settings:
  database_url: str = _get_env("DATABASE_URL", required=True)
  bids_exporter_url: str = _get_env("BIDS_EXPORTER_URL", "http://bids_exporter:8000")
  auth_manager_url: str = _get_env("AUTH_MANAGER_URL", "http://auth_manager:3000")
  shared_volume_path: str = _get_env("SHARED_VOLUME_PATH", "/export_data")


settings = Settings()
