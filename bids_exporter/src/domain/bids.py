import os
import shutil
import json
import struct
from contextlib import contextmanager
from pathlib import Path
from typing import Dict, List, Tuple, TypedDict
from uuid import UUID

import mne
import numpy as np
import pandas as pd
from mne_bids import BIDSPath, write_raw_bids

from ..config.env import settings
from ..infrastructure.db import get_db_connection, get_db_cursor
from ..infrastructure.object_storage import (
    object_storage_client,
    RAW_DATA_BUCKET,
    MEDIA_BUCKET,
    BIDS_BUCKET,
)
from .tasks import update_task_status


class ChannelQualityMeta(TypedDict):
    status: str
    reasons: List[str]
    zero_ratio: float
    bad_impedance_ratio: float
    unknown_impedance_ratio: float
    flatline: bool
    type: str
    has_warning: bool


class ChannelQualityAccumulator:
    """Collects quality indicators for each channel while streaming session chunks."""

    def __init__(self, ch_names: List[str], ch_types: List[str]) -> None:
        self.ch_names = ch_names
        self.ch_types = ch_types
        self.num_channels = len(ch_names)
        self.analysis_indices = np.array(
            [ch_type in {"eeg", "emg", "eog"} for ch_type in ch_types], dtype=bool
        )
        self.total_samples = np.zeros(self.num_channels, dtype=np.int64)
        self.zero_samples = np.zeros(self.num_channels, dtype=np.int64)
        self.high_impedance_samples = np.zeros(self.num_channels, dtype=np.int64)
        self.unknown_impedance_samples = np.zeros(self.num_channels, dtype=np.int64)
        self.flatline_detected = np.zeros(self.num_channels, dtype=bool)

    def update(self, signals: np.ndarray, impedances: np.ndarray) -> None:
        """
        Update internal counters with the latest chunk.

        :param signals: Array shaped (num_channels, num_samples) containing raw ADC values.
        :param impedances: Array shaped (num_channels, num_samples) containing impedance codes.
        """
        if signals.size == 0 or signals.shape[0] != self.num_channels:
            return

        num_samples = signals.shape[1]
        self.total_samples += num_samples

        if not np.any(self.analysis_indices):
            return

        analysis_signals = signals[self.analysis_indices]
        analysis_impedances = impedances[self.analysis_indices]

        self.zero_samples[self.analysis_indices] += np.count_nonzero(
            analysis_signals == 0, axis=1
        )

        unknown_mask = analysis_impedances == 255
        self.unknown_impedance_samples[self.analysis_indices] += np.count_nonzero(
            unknown_mask, axis=1
        )

        high_mask = (analysis_impedances >= settings.channel_bad_impedance_threshold) & (~unknown_mask)
        self.high_impedance_samples[self.analysis_indices] += np.count_nonzero(
            high_mask, axis=1
        )

        ptp_values = np.ptp(analysis_signals, axis=1)
        self.flatline_detected[self.analysis_indices] |= (
            ptp_values <= settings.channel_flatline_ptp_threshold
        )

    def finalize(self) -> Tuple[Dict[str, ChannelQualityMeta], List[str]]:
        """
        Build a per-channel quality report and the list of bad channels.
        """
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

        return report, bad_channels


@contextmanager
def _managed_object_storage_object(bucket: str, object_id: str):
    response = None
    try:
        response = object_storage_client.get_object(bucket, object_id)
        yield response
    finally:
        if response is not None:
            try:
                response.close()
            except Exception as close_error:  # pragma: no cover - defensive logging
                print(f"Warning: Failed to close object storage response for {object_id}: {close_error}")
            try:
                response.release_conn()
            except Exception as release_error:  # pragma: no cover - defensive logging
                print(
                    f"Warning: Failed to release object storage connection for {object_id}: {release_error}"
                )
def parse_payload(data: bytes) -> dict | None:
    """
    最新のデータフォーマットのバイナリペイロードを解析し、チャンネル情報と全チャンネルのデータを抽出する。
    sampling_rate と lsb_to_volts はDBから取得するため、ここでは解析しない。
    """
    try:
        if len(data) < 4:  # version(1) + num_channels(1) + reserved(2)
            return None

        offset = 0
        version, num_channels = struct.unpack_from('<BB', data, offset); offset += 2

        if version != 0x04:
            print(f"Warning: Unsupported payload version: {version}. Expected 4.")
            return None

        offset += 2  # reserved

        header_size = offset + (num_channels * 10)
        if len(data) < header_size:
            return None

        ch_names = []
        ch_types = []
        type_map = {'eeg': 0, 'emg': 1, 'eog': 2, 'stim': 3, 'misc': 255}
        int_to_type_map = {v: k for k, v in type_map.items()}

        for i in range(num_channels):
            name_bytes = data[offset : offset + 8]; offset += 8
            ch_type_int = data[offset]; offset += 1
            offset += 1  # reserved
            ch_names.append(name_bytes.split(b'\x00', 1)[0].decode('utf-8'))
            ch_types.append(int_to_type_map.get(ch_type_int, 'misc'))
        
        # 1サンプルあたりのサイズ: signals(ch*2) + accel(6) + gyro(6) + impedance(ch*1)
        sample_size = (num_channels * 2) + 6 + 6 + num_channels

        samples_buffer = data[header_size:]
        num_samples = len(samples_buffer) // sample_size

        if num_samples == 0:
            empty = np.empty((num_channels, 0), dtype=np.int16)
            return {
                "ch_names": ch_names,
                "ch_types": ch_types,
                "signals": empty,
                "impedance": np.empty((num_channels, 0), dtype=np.uint8),
            }

        all_samples_flat = np.frombuffer(samples_buffer, dtype=np.uint8, count=num_samples * sample_size)
        samples_matrix = np.lib.stride_tricks.as_strided(
            all_samples_flat,
            shape=(num_samples, sample_size),
            strides=(sample_size, 1),
        ).copy()

        signal_section = samples_matrix[:, : num_channels * 2]
        impedance_section = samples_matrix[:, (num_channels * 2) + 12 : (num_channels * 2) + 12 + num_channels]

        signal_bytes = signal_section.reshape(-1).tobytes()
        signals = np.frombuffer(signal_bytes, dtype="<i2", count=num_samples * num_channels).reshape(
            num_samples, num_channels
        ).T

        impedance = impedance_section.reshape(num_samples, num_channels).astype(np.uint8).T

        return {
            "ch_names": ch_names,
            "ch_types": ch_types,
            "signals": signals,
            "impedance": impedance,
        }

    except Exception as e:
        print(f"Error parsing binary payload: {e}")
        return None


def create_bids_dataset(
    experiment_id: UUID,
    task_id: UUID,
    output_dir: str | Path,
    zip_output: bool = True
) -> str:
    """
    BIDSエクスポートプロセスを調整するメイン関数。チャンネルタイプを動的に処理する。
    """
    bids_root = Path(output_dir) / "bids_dataset"
    if bids_root.exists():
        shutil.rmtree(bids_root)
    os.makedirs(bids_root, exist_ok=True)
    print(f"[Task: {task_id}] Starting export for experiment {experiment_id}. Output dir: {bids_root}")

    try:
        update_task_status(task_id, progress=5, status_message="Fetching metadata")
        with get_db_connection() as conn:
            with get_db_cursor(conn) as cur:
                # --- 1. 実験とセッションのメタデータを取得 ---
                cur.execute("SELECT name, description FROM experiments WHERE experiment_id = %s", (str(experiment_id),))
                exp = cur.fetchone()
                if not exp:
                    raise ValueError(f"Experiment {experiment_id} not found.")

                cur.execute(
                    "SELECT * FROM sessions WHERE experiment_id = %s AND link_status = 'completed' ORDER BY start_time",
                    (str(experiment_id),)
                )
                sessions = cur.fetchall()
                if not sessions:
                    raise ValueError(f"No fully processed sessions found for experiment {experiment_id}.")

                # --- 2. トップレベルのBIDSファイルを作成 ---
                dataset_description_path = bids_root / 'dataset_description.json'
                if dataset_description_path.exists():
                    dataset_description_path.unlink()

                dataset_description = {
                    "Name": exp['name'], "BIDSVersion": "1.8.0", "DatasetType": "raw",
                    "Authors": ["EEG Platform User"]
                }
                with open(bids_root / 'dataset_description.json', 'w') as f:
                    json.dump(dataset_description, f, indent=2)

                participant_ids = sorted(list(set([s['user_id'].replace('-', '') for s in sessions])))
                participants_df = pd.DataFrame({'participant_id': participant_ids})
                participants_df.to_csv(bids_root / 'participants.tsv', sep='\t', index=False)
                
                # --- 3. 刺激（Stimuli）をダウンロード ---
                update_task_status(task_id, progress=15, status_message="Downloading stimuli")
                stimuli_dir = bids_root / 'stimuli'
                os.makedirs(stimuli_dir, exist_ok=True)
                
                cur.execute("SELECT file_name, object_id FROM experiment_stimuli WHERE experiment_id = %s", (str(experiment_id),))
                stimuli = cur.fetchall()
                if stimuli:
                    for stim in stimuli:
                        stim_path = stimuli_dir / stim['file_name']
                        object_storage_client.fget_object(MEDIA_BUCKET, stim['object_id'], str(stim_path))
                    
                    stimuli_df = pd.DataFrame({'stim_file': [f"stimuli/{s['file_name']}" for s in stimuli]})
                    stimuli_df.to_csv(bids_root / 'stimuli.tsv', sep='\t', index=False)

                # --- 4. 各セッションを処理 ---
                for i, session in enumerate(sessions):
                    progress = 20 + int(70 * (i / len(sessions)))
                    update_task_status(task_id, progress=progress, status_message=f"Processing session {i+1}/{len(sessions)}")

                    subject_id = session['user_id'].replace('-', '')
                    
                    raw_task_name = session.get('session_type', exp['name'])
                    task_name = "defaulttask"
                    if raw_task_name and raw_task_name.strip():
                        task_name = raw_task_name.replace('_', '').replace('-', '').replace(' ', '')

                    bids_path = BIDSPath(subject=subject_id, session=str(i+1), task=task_name, root=bids_root, datatype='eeg')

                    cur.execute(
                        """
                        SELECT rdo.object_id, rdo.timestamp_start_ms, rdo.sampling_rate, rdo.lsb_to_volts
                        FROM raw_data_objects rdo JOIN session_object_links sol ON rdo.object_id = sol.object_id
                        WHERE sol.session_id = %s ORDER BY rdo.timestamp_start_ms ASC
                        """,
                        (session['session_id'],)
                    )
                    data_objects = cur.fetchall()
                    if not data_objects:
                        print(f"Warning: No raw data found for session {session['session_id']}. Skipping.")
                        continue
                    
                    session_t0_ms = data_objects[0]['timestamp_start_ms']
                    
                    all_session_data: List[np.ndarray] = []
                    session_ch_names = None
                    session_ch_types = None
                    session_sampling_rate = None
                    session_lsb_to_volts = None
                    quality_accumulator: ChannelQualityAccumulator | None = None
                    
                    for obj in data_objects:
                        with _managed_object_storage_object(RAW_DATA_BUCKET, obj['object_id']) as response:
                            payload = response.read()

                            if not payload:
                                print(f"Warning: Object {obj['object_id']} is empty. Skipping.")
                                continue

                            parsed = parse_payload(payload)

                            if not parsed:
                                print(f"Warning: Failed to parse object {obj['object_id']}. Skipping.")
                                continue

                            if session_sampling_rate is None:
                                session_sampling_rate = obj['sampling_rate']
                                session_lsb_to_volts = obj['lsb_to_volts']
                                session_ch_names = parsed['ch_names']
                                session_ch_types = parsed['ch_types']
                                quality_accumulator = ChannelQualityAccumulator(
                                    session_ch_names, session_ch_types
                                )

                            elif (
                                session_ch_names != parsed['ch_names']
                                or session_sampling_rate != obj['sampling_rate']
                                or session_lsb_to_volts != obj['lsb_to_volts']
                            ):
                                print(
                                    f"Warning: Inconsistent data parameters in session {session['session_id']}. Skipping object {obj['object_id']}."
                                )
                                continue

                            if parsed["signals"] is not None and parsed["signals"].size > 0:
                                all_session_data.append(parsed["signals"])
                                if quality_accumulator is not None:
                                    quality_accumulator.update(
                                        parsed["signals"], parsed["impedance"]
                                    )

                    if not all_session_data or not session_ch_names or not session_ch_types or not session_sampling_rate or not session_lsb_to_volts:
                        print(f"Warning: Could not parse any valid data for session {session['session_id']}. Skipping.")
                        continue

                    channel_report: Dict[str, ChannelQualityMeta] = {}
                    bad_channels: List[str] = []

                    if quality_accumulator is not None:
                        channel_report, bad_channels = quality_accumulator.finalize()

                    full_data_adc = np.concatenate(all_session_data, axis=1)
                    
                    scaling_factors = np.array([
                        session_lsb_to_volts if ctype in ['eeg', 'emg', 'eog', 'misc'] else 1.0
                        for ctype in session_ch_types
                    ]).reshape(-1, 1)
                    full_data_scaled = full_data_adc.astype(np.float64) * scaling_factors

                    mne_info = mne.create_info(
                        ch_names=session_ch_names, 
                        sfreq=session_sampling_rate, 
                        ch_types=session_ch_types
                    )
                    mne_info.set_montage("standard_1020", on_missing='warn')
                    raw = mne.io.RawArray(full_data_scaled, mne_info, verbose=False)
                    raw.info['bads'] = bad_channels
                    
                    cur.execute(
                        """
                        SELECT se.onset, se.duration, se.trial_type, se.onset_corrected_us, COALESCE(es.file_name, ci.file_name) as file_name
                        FROM session_events se
                        LEFT JOIN experiment_stimuli es ON se.stimulus_id = es.stimulus_id
                        LEFT JOIN calibration_items ci ON se.calibration_item_id = ci.item_id
                        WHERE se.session_id = %s AND se.onset_corrected_us IS NOT NULL
                        ORDER BY se.onset_corrected_us ASC
                        """,
                        (session['session_id'],)
                    )
                    events = cur.fetchall()

                    write_raw_bids(raw, bids_path, overwrite=True, verbose=False, allow_preload=True, format='EDF')
                    
                    if events:
                        session_t0_us = session_t0_ms * 1000
                        events_data = {
                            'onset': [(e['onset_corrected_us'] - session_t0_us) / 1_000_000.0 for e in events],
                            'duration': [e['duration'] for e in events],
                            'trial_type': [e['trial_type'] for e in events],
                            'stim_file': [f"stimuli/{e['file_name']}" if e['file_name'] else "n/a" for e in events]
                        }
                        events_df = pd.DataFrame(events_data)
                        events_df.to_csv(bids_path.copy().update(suffix='events', extension='.tsv'), sep='\t', index=False)

                    sidecar_path = bids_path.copy().update(suffix='eeg', extension='.json').fpath
                    with open(sidecar_path, 'r', encoding='utf-8') as f:
                        sidecar_data = json.load(f)

                    sidecar_data['PowerLineFrequency'] = 50
                    sidecar_data['EEGReference'] = "n/a"

                    with open(sidecar_path, 'w', encoding='utf-8') as f:
                        json.dump(sidecar_data, f, indent=4)

                    channels_path = bids_path.copy().update(suffix='channels', extension='.tsv').fpath
                    channels_df = pd.read_csv(channels_path, sep='\t')
                    channels_df.columns = [col.strip() for col in channels_df.columns]
                    channel_name_column = 'name'
                    if channel_name_column not in channels_df.columns:
                        channel_name_column = channels_df.columns[0]

                    valid_channel_names = set(raw.ch_names)
                    channels_df = channels_df[channels_df[channel_name_column].isin(valid_channel_names)].copy()
                    def _map_status(channel_name: str) -> str:
                        meta = channel_report.get(channel_name)
                        if not meta:
                            return "good"
                        return meta["status"]

                    def _map_description(channel_name: str) -> str:
                        meta = channel_report.get(channel_name)
                        if not meta:
                            return "n/a"
                        reasons = meta["reasons"]
                        if reasons:
                            return "; ".join(reasons)
                        if meta["has_warning"]:
                            return "warning"
                        return "n/a"

                    if 'status' not in channels_df.columns:
                        channels_df['status'] = 'good'
                    if 'status_description' not in channels_df.columns:
                        channels_df['status_description'] = 'n/a'

                    channels_df['status'] = channels_df[channel_name_column].map(_map_status)
                    channels_df['status_description'] = channels_df[channel_name_column].map(_map_description)
                    channels_df.to_csv(channels_path, sep='\t', index=False, na_rep='n/a')

                    quality_path = bids_path.copy().update(
                        description='quality',
                        suffix='channels',
                        extension='.json'
                    ).fpath
                    with open(quality_path, 'w', encoding='utf-8') as f:
                        json.dump(channel_report, f, indent=2)

        if zip_output:
            update_task_status(task_id, progress=90, status_message="Compressing dataset")
            zip_base_name = Path(output_dir) / f"eid_{experiment_id}"
            zip_path = shutil.make_archive(
                base_name=str(zip_base_name),
                format='zip',
                root_dir=output_dir,
                base_dir='bids_dataset'
            )
            
            object_name = os.path.basename(zip_path)
            object_storage_client.fput_object(
                bucket_name=BIDS_BUCKET,
                object_name=object_name,
                file_path=zip_path,
            )
            print(f"[Task: {task_id}] Uploaded BIDS archive to object storage: {object_name}")

            update_task_status(task_id, progress=100, status='completed', result_path=object_name)
            return zip_path
        else:
            update_task_status(task_id, progress=100, status='completed', result_path=str(bids_root.resolve()))
            return str(bids_root.resolve())

    except Exception as e:
        print(f"❌ BIDS export failed for task {task_id}: {e}")
        import traceback
        traceback.print_exc()
        update_task_status(task_id, status='failed', error_message=str(e))
        raise
    finally:
        if 'bids_root' in locals() and bids_root.exists() and zip_output:
            shutil.rmtree(bids_root)
        if zip_output and 'zip_path' in locals():
            try:
                Path(zip_path).unlink(missing_ok=True)  # type: ignore[arg-type]
            except Exception:
                pass
