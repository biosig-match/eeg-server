from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .channel_quality import ChannelQualityTracker
from .types import ChannelQualityMeta, DeviceProfile


@dataclass
class UserState:
    profile: DeviceProfile
    buffer: np.ndarray
    tracker: ChannelQualityTracker

    def with_updated_quality(
        self,
        bad_channels: list[str],
        channel_report: dict[str, ChannelQualityMeta],
    ) -> None:
        self.profile["bad_channels"] = bad_channels
        self.profile["channel_report"] = channel_report
