from typing import NotRequired, TypedDict

import mne


class ChannelQualityMeta(TypedDict):
    status: str
    reasons: list[str]
    zero_ratio: float
    bad_impedance_ratio: float
    unknown_impedance_ratio: float
    flatline: bool
    type: str
    has_warning: bool


class DeviceProfile(TypedDict):
    ch_names: list[str]
    ch_types: list[str]
    sampling_rate: float
    lsb_to_volts: float
    mne_info: mne.Info
    bad_channels: NotRequired[list[str]]
    channel_report: NotRequired[dict[str, ChannelQualityMeta]]
