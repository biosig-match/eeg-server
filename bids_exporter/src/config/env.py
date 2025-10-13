from dataclasses import dataclass
import os


def _get_env(name: str, default: str | None = None, *, required: bool = False) -> str:
  value = os.getenv(name, default)
  if value is None or (required and value == ""):
    raise RuntimeError(f"Environment variable '{name}' is required")
  return value


def _get_bool(name: str, default: bool = False) -> bool:
  raw = os.getenv(name)
  if raw is None:
    return default
  return raw.lower() in {"1", "true", "yes", "on"}


def _get_float(name: str, default: float) -> float:
  raw = os.getenv(name)
  if raw is None:
    return default
  try:
    return float(raw)
  except ValueError as exc:
    raise RuntimeError(f"Environment variable '{name}' must be a float.") from exc


def _get_int(name: str, default: int) -> int:
  raw = os.getenv(name)
  if raw is None:
    return default
  try:
    return int(raw)
  except ValueError as exc:
    raise RuntimeError(f"Environment variable '{name}' must be an integer.") from exc


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
  channel_zero_ratio_threshold: float = _get_float("CHANNEL_ZERO_RATIO_THRESHOLD", 0.98)
  channel_flatline_ptp_threshold: int = _get_int("CHANNEL_FLATLINE_PTP_THRESHOLD", 5)
  channel_bad_impedance_threshold: int = _get_int("CHANNEL_BAD_IMPEDANCE_THRESHOLD", 200)
  channel_bad_impedance_ratio: float = _get_float("CHANNEL_BAD_IMPEDANCE_RATIO", 0.5)
  channel_unknown_impedance_ratio: float = _get_float("CHANNEL_UNKNOWN_IMPEDANCE_RATIO", 0.75)


settings = Settings()
