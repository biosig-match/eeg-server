from typing import Dict, List, NotRequired, TypedDict

import mne


class ChannelQualityMeta(TypedDict):
    status: str
    reasons: List[str]
    zero_ratio: float
    bad_impedance_ratio: float
    unknown_impedance_ratio: float
    flatline: bool
    type: str
    has_warning: bool


class DeviceProfile(TypedDict):
    ch_names: List[str]
    ch_types: List[str]
    sampling_rate: float
    lsb_to_volts: float
    mne_info: mne.Info
    bad_channels: NotRequired[List[str]]
    channel_report: NotRequired[Dict[str, ChannelQualityMeta]]
