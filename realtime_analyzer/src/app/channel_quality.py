from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np

from ..config.env import settings
from .types import ChannelQualityMeta


class ChannelQualityTracker:
    """Accumulates per-channel quality statistics from streaming data."""

    def __init__(self, ch_names: List[str], ch_types: List[str]) -> None:
        self.ch_names = ch_names
        self.ch_types = ch_types
        self.num_channels = len(ch_names)
        self.analysis_indices = np.array(
            [ch_type in {"eeg", "emg", "eog"} for ch_type in ch_types],
            dtype=bool,
        )
        self.total_samples = np.zeros(self.num_channels, dtype=np.int64)
        self.zero_samples = np.zeros(self.num_channels, dtype=np.int64)
        self.high_impedance_samples = np.zeros(self.num_channels, dtype=np.int64)
        self.unknown_impedance_samples = np.zeros(self.num_channels, dtype=np.int64)
        self.flatline_detected = np.zeros(self.num_channels, dtype=bool)
        self._dirty = True
        self._cached_bad_channels: List[str] = []
        self._cached_report: Dict[str, ChannelQualityMeta] = {}

    def update(self, signals: np.ndarray, impedances: np.ndarray) -> None:
        """Update per-channel quality statistics with a new batch of samples."""
        if signals.size == 0 or signals.shape[1] != self.num_channels:
            return

        signals_t = signals.T
        self.total_samples += signals_t.shape[1]

        if np.any(self.analysis_indices):
            analysis_signals = signals_t[self.analysis_indices]
            self.zero_samples[self.analysis_indices] += np.count_nonzero(
                analysis_signals == 0, axis=1
            )
            ptp_values = np.ptp(analysis_signals, axis=1)
            self.flatline_detected[self.analysis_indices] |= (
                ptp_values <= settings.channel_flatline_ptp_threshold
            )

            if (
                impedances.size > 0
                and impedances.shape[1] == self.num_channels
                and impedances.shape[0] == signals.shape[0]
            ):
                impedances_t = impedances.T
                analysis_impedances = impedances_t[self.analysis_indices]
                unknown_mask = analysis_impedances == 255
                self.unknown_impedance_samples[self.analysis_indices] += np.count_nonzero(
                    unknown_mask, axis=1
                )
                high_mask = (analysis_impedances >= settings.channel_bad_impedance_threshold) & (
                    ~unknown_mask
                )
                self.high_impedance_samples[self.analysis_indices] += np.count_nonzero(
                    high_mask, axis=1
                )

        self._dirty = True

    def build_report(self) -> Tuple[List[str], Dict[str, ChannelQualityMeta]]:
        """Return bad channel list and channel quality report."""
        if not self._dirty:
            return self._cached_bad_channels, self._cached_report

        report: Dict[str, ChannelQualityMeta] = {}
        bad_channels: List[str] = []

        for idx, name in enumerate(self.ch_names):
            ch_type = self.ch_types[idx]
            total = max(int(self.total_samples[idx]), 1)
            zero_ratio = float(self.zero_samples[idx]) / total
            high_ratio = float(self.high_impedance_samples[idx]) / total
            unknown_ratio = float(self.unknown_impedance_samples[idx]) / total
            reasons: List[str] = []
            status = "good"

            if self.analysis_indices[idx]:
                if zero_ratio >= settings.channel_zero_ratio_threshold:
                    status = "bad"
                    reasons.append(f"zero-fill {zero_ratio:.0%}")

                if high_ratio >= settings.channel_bad_impedance_ratio:
                    status = "bad"
                    reasons.append(f"impedance high {high_ratio:.0%}")
                elif unknown_ratio >= settings.channel_unknown_impedance_ratio:
                    reasons.append(f"impedance unknown {unknown_ratio:.0%}")

                if self.flatline_detected[idx]:
                    reasons.append("flatline amplitude")

            if status == "bad":
                bad_channels.append(name)

            report[name] = {
                "status": status,
                "reasons": reasons,
                "zero_ratio": zero_ratio if self.analysis_indices[idx] else 0.0,
                "bad_impedance_ratio": high_ratio if self.analysis_indices[idx] else 0.0,
                "unknown_impedance_ratio": unknown_ratio if self.analysis_indices[idx] else 0.0,
                "flatline": bool(self.flatline_detected[idx]) if self.analysis_indices[idx] else False,
                "type": ch_type,
                "has_warning": status != "bad" and bool(reasons),
            }

        self._cached_bad_channels = bad_channels
        self._cached_report = report
        self._dirty = False
        return bad_channels, report
