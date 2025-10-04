from dataclasses import dataclass
import os


def _get_env(name: str, default: str | None = None, *, required: bool = False) -> str:
  value = os.getenv(name, default)
  if required and (value is None or value == ""):
    raise RuntimeError(f"Environment variable '{name}' is required")
  if value is None:
    raise RuntimeError(f"Environment variable '{name}' is required")
  return value


def _get_bool(name: str, default: bool = False) -> bool:
  raw = os.getenv(name)
  if raw is None:
    return default
  return raw.lower() in {"1", "true", "yes", "on"}


def _get_optional(name: str, default: str | None = None) -> str | None:
  value = os.getenv(name, default)
  return value


@dataclass(frozen=True)
class Settings:
  database_url: str = _get_env("DATABASE_URL", required=True)
  minio_endpoint: str = _get_env("MINIO_ENDPOINT", "minio:9000")
  minio_access_key: str = _get_env("MINIO_ACCESS_KEY", required=True)
  minio_secret_key: str = _get_env("MINIO_SECRET_KEY", required=True)
  minio_use_ssl: bool = _get_bool("MINIO_USE_SSL", False)
  minio_raw_data_bucket: str = _get_env("MINIO_RAW_DATA_BUCKET", required=True)
  minio_media_bucket: str = _get_env("MINIO_MEDIA_BUCKET", required=True)
  minio_bids_exports_bucket: str = _get_env("MINIO_BIDS_EXPORTS_BUCKET", "bids-exports")
  export_output_dir: str = _get_env("EXPORT_OUTPUT_DIR", "/export_data")


settings = Settings()
