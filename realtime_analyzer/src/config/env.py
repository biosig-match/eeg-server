import os
from dataclasses import dataclass


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


def _get_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    return float(raw)


@dataclass(frozen=True)
class Settings:
    rabbitmq_url: str = _get_env("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672")
    sample_rate: int = _get_int("SAMPLE_RATE", 256)
    analysis_window_seconds: float = float(os.getenv("ANALYSIS_WINDOW_SEC", "2.0"))
    analysis_interval_seconds: int = _get_int("ANALYSIS_INTERVAL_SECONDS", 10)
    enable_debug_logging: bool = _get_bool("REALTIME_ANALYZER_DEBUG", False)
    channel_zero_ratio_threshold: float = _get_float("CHANNEL_ZERO_RATIO_THRESHOLD", 0.98)
    channel_flatline_ptp_threshold: int = _get_int("CHANNEL_FLATLINE_PTP_THRESHOLD", 5)
    channel_bad_impedance_threshold: int = _get_int("CHANNEL_BAD_IMPEDANCE_THRESHOLD", 200)
    channel_bad_impedance_ratio: float = _get_float("CHANNEL_BAD_IMPEDANCE_RATIO", 0.5)
    channel_unknown_impedance_ratio: float = _get_float("CHANNEL_UNKNOWN_IMPEDANCE_RATIO", 0.75)


settings = Settings()
