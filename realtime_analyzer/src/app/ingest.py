from __future__ import annotations

import struct
from typing import Optional

import numpy as np


def parse_eeg_binary_payload_v4(data: bytes) -> Optional[dict]:
    """Parse the EEG payload version 4 into header, signals, and impedance arrays."""
    try:
        header_base_size = 4  # version(1) + num_channels(1) + reserved(2)
        if len(data) < header_base_size:
            print(f"Error: Payload is too short for header: {len(data)} bytes")
            return None

        offset = 0
        version, num_channels = struct.unpack_from("<BB", data, offset)
        offset += 2

        if version != 0x04:
            print(f"Error: Unsupported payload version: {version}")
            return None

        offset += 2  # reserved(2)

        header_channels_size = num_channels * 10
        header_size = offset + header_channels_size
        if len(data) < header_size:
            print(
                "Error: Data is too short for electrode config. "
                f"Expected: {header_size}, Actual: {len(data)}"
            )
            return None

        ch_names, ch_types_str = [], []
        type_map = {0: "eeg", 1: "emg", 2: "eog", 3: "stim", 255: "misc"}
        for _ in range(num_channels):
            name_bytes = data[offset : offset + 8]
            offset += 8
            ch_type_int = data[offset]
            offset += 1
            offset += 1  # reserved(1)
            ch_names.append(name_bytes.split(b"\x00", 1)[0].decode("utf-8"))
            ch_types_str.append(type_map.get(ch_type_int, "misc"))

        # Sample structure: signals(ch*2) + accel(6) + gyro(6) + impedance(ch*1)
        sample_size = (num_channels * 2) + 6 + 6 + num_channels
        samples_buffer = data[header_size:]
        num_samples = len(samples_buffer) // sample_size

        if num_samples == 0:
            empty_signals = np.empty((0, num_channels), dtype=np.int16)
            empty_impedance = np.empty((0, num_channels), dtype=np.uint8)
            return {
                "header": {
                    "ch_names": ch_names,
                    "ch_types": ch_types_str,
                },
                "signals": empty_signals,
                "impedance": empty_impedance,
            }

        all_samples_flat = np.frombuffer(
            samples_buffer,
            dtype=np.uint8,
            count=num_samples * sample_size,
        )
        samples_matrix = np.lib.stride_tricks.as_strided(
            all_samples_flat,
            shape=(num_samples, sample_size),
            strides=(sample_size, 1),
        ).copy()

        signal_section = samples_matrix[:, : num_channels * 2]
        impedance_section = samples_matrix[
            :,
            (num_channels * 2) + 12 : (num_channels * 2) + 12 + num_channels,
        ]

        signal_bytes = signal_section.reshape(-1).tobytes()
        signals = np.frombuffer(
            signal_bytes,
            dtype="<i2",
            count=num_samples * num_channels,
        ).reshape(num_samples, num_channels)

        impedance = impedance_section.reshape(num_samples, num_channels).astype(np.uint8)

        return {
            "header": {
                "ch_names": ch_names,
                "ch_types": ch_types_str,
            },
            "signals": signals,
            "impedance": impedance,
        }
    except Exception as exc:
        print(f"バイナリデータの解析中にエラーが発生しました: {exc}")
        return None
