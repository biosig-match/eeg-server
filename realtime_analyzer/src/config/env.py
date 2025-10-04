from dataclasses import dataclass
import os


def _get_env(name: str, default: str | None = None, *, required: bool = False) -> str:
  value = os.getenv(name, default)
  if value is None or (required and value == ""):
    raise RuntimeError(f"Environment variable '{name}' is required")
  return value


def _get_int(name: str, default: int) -> int:
  raw = os.getenv(name)
  if raw is None:
    return default
  return int(raw)


def _get_bool(name: str, default: bool = False) -> bool:
  raw = os.getenv(name)
  if raw is None:
    return default
  return raw.lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
  rabbitmq_url: str = _get_env("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672")
  sample_rate: int = _get_int("SAMPLE_RATE", 256)
  analysis_window_seconds: float = float(os.getenv("ANALYSIS_WINDOW_SEC", "2.0"))
  analysis_interval_seconds: int = _get_int("ANALYSIS_INTERVAL_SECONDS", 10)
  enable_debug_logging: bool = _get_bool("REALTIME_ANALYZER_DEBUG", False)


settings = Settings()
