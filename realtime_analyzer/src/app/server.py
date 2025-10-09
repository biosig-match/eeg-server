import base64
import io
import struct
import threading
import time
from collections import defaultdict
from datetime import datetime
from typing import Any, Dict, List, Optional, TypedDict, cast
from typing import NotRequired

import matplotlib
import matplotlib.pyplot as plt
import mne
import numpy as np
import pika
from pika import exceptions as pika_exceptions
import zstandard
from flask import Flask, jsonify
from mne_connectivity import spectral_connectivity_epochs
from mne_connectivity.viz import plot_connectivity_circle

from ..config.env import settings

matplotlib.use("Agg")

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

app = Flask(__name__)

user_device_profiles: Dict[str, DeviceProfile] = {}
user_data_buffers: Dict[str, np.ndarray] = defaultdict(lambda: np.array([]))

latest_analysis_results: dict[str, dict[str, Any]] = defaultdict(dict)
analysis_lock = threading.Lock()
buffer_lock = threading.Lock()
threads_started = False
rabbitmq_connected_event = threading.Event()
channel_quality_trackers: Dict[str, "ChannelQualityTracker"] = {}


class ChannelQualityTracker:

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
        self._dirty = True
        self._cached_bad_channels: List[str] = []
        self._cached_report: Dict[str, ChannelQualityMeta] = {}

    def update(self, signals: np.ndarray, impedances: np.ndarray) -> None:
        """
        signals: shape (num_samples, num_channels)
        impedances: shape (num_samples, num_channels)
        """
        if signals.size == 0:
            return
        if signals.shape[1] != self.num_channels:
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
                high_mask = (analysis_impedances >= settings.channel_bad_impedance_threshold) & (~unknown_mask)
                self.high_impedance_samples[self.analysis_indices] += np.count_nonzero(
                    high_mask, axis=1
                )

        self._dirty = True

    def build_report(self) -> tuple[List[str], Dict[str, ChannelQualityMeta]]:
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


def parse_eeg_binary_payload_v4(data: bytes) -> Optional[dict]:

    try:
        header_base_size = 4  # version(1) + num_channels(1) + reserved(2)
        if len(data) < header_base_size:
            print(f"Error: Payload is too short for header: {len(data)} bytes")
            return None

        offset = 0
        version, num_channels = struct.unpack_from('<BB', data, offset); offset += 2

        if version != 0x04:
            print(f"Error: Unsupported payload version: {version}")
            return None
        
        offset += 2  # reserved(2)

        header_channels_size = num_channels * 10
        header_size = offset + header_channels_size
        if len(data) < header_size:
            print(f"Error: Data is too short for electrode config. Expected: {header_size}, Actual: {len(data)}")
            return None

        ch_names, ch_types_str = [], []
        type_map = {0: 'eeg', 1: 'emg', 2: 'eog', 3: 'stim', 255: 'misc'}
        for _ in range(num_channels):
            name_bytes = data[offset : offset + 8]; offset += 8
            ch_type_int = data[offset]; offset += 1
            offset += 1  # reserved(1)
            ch_names.append(name_bytes.split(b'\x00', 1)[0].decode('utf-8'))
            ch_types_str.append(type_map.get(ch_type_int, 'misc'))

        # 1サンプルあたりのサイズ: signals(ch*2) + accel(6) + gyro(6) + impedance(ch*1)
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
        )

        impedance = impedance_section.reshape(num_samples, num_channels).astype(np.uint8)

        return {
            "header": {
                "ch_names": ch_names,
                "ch_types": ch_types_str,
            },
            "signals": signals,
            "impedance": impedance,
        }
    except Exception as e:
        print(f"バイナリデータの解析中にエラーが発生しました: {e}")
        return None


def fig_to_base64(fig) -> str:
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)
    buffer.seek(0)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def analysis_worker() -> None:
    print("✅ 解析ワーカースレッドが起動しました。")
    while True:
        time.sleep(settings.analysis_interval_seconds)
        with buffer_lock:
            current_buffers = dict(user_data_buffers)
            current_profiles = {
                uid: user_device_profiles.get(uid) for uid in current_buffers.keys()
            }

        for user_id, buffer in current_buffers.items():
            profile = current_profiles.get(user_id)
            if not profile:
                continue

            analysis_samples = int(profile['sampling_rate'] * settings.analysis_window_seconds)
            if buffer.shape[0] < analysis_samples or analysis_samples == 0:
                continue
            
            data_chunk = buffer[-analysis_samples:, :]
            try:
                bad_channels = set(profile.get("bad_channels", []))
                allowed_types = {"eeg", "emg", "eog"}
                analysis_indices = [
                    idx
                    for idx, (name, ch_type) in enumerate(zip(profile["ch_names"], profile["ch_types"]))
                    if ch_type in allowed_types and name not in bad_channels
                ]

                if not analysis_indices:
                    if settings.enable_debug_logging:
                        print(f"ユーザー({user_id})に解析可能な良好チャネルが存在しません。スキップします。")
                    continue

                analysis_channels = [profile["ch_names"][idx] for idx in analysis_indices]
                analysis_types = [profile["ch_types"][idx] for idx in analysis_indices]

                data_chunk_good = data_chunk[:, analysis_indices]

                data_in_volts = data_chunk_good.T.astype(np.float64) * profile['lsb_to_volts']

                info_copy = profile['mne_info'].copy()
                pick_indices = [profile['ch_names'].index(name) for name in analysis_channels]
                analysis_info = mne.pick_info(info_copy, sel=pick_indices, copy=True)
                analysis_info['bads'] = [name for name in bad_channels if name in analysis_channels]

                raw = mne.io.RawArray(data_in_volts, analysis_info, verbose=False)

                fig_psd = raw.compute_psd(
                    fmin=1, fmax=45, n_fft=int(profile['sampling_rate']), verbose=False
                ).plot(show=False, spatial_colors=True)
                psd_b64 = fig_to_base64(fig_psd)

                epochs = mne.make_fixed_length_epochs(
                    raw, duration=settings.analysis_window_seconds, preload=True, verbose=False
                )
                con = spectral_connectivity_epochs(
                    epochs, method="coh", sfreq=profile['sampling_rate'],
                    fmin=8, fmax=13, faverage=True, verbose=False,
                )
                con_matrix = np.squeeze(con.get_data(output="dense"))
                eeg_indices = mne.pick_types(analysis_info, eeg=True)
                eeg_ch_names = [analysis_channels[i] for i in eeg_indices]

                coh_b64 = ""
                if len(eeg_ch_names) > 1:
                    fig_coh, _ = plot_connectivity_circle(
                        con_matrix[np.ix_(eeg_indices, eeg_indices)], eeg_ch_names, show=False, vmin=0, vmax=1
                    )
                    coh_b64 = fig_to_base64(fig_coh)

                channel_report = cast(Dict[str, ChannelQualityMeta], profile.get("channel_report", {}))

                with analysis_lock:
                    latest_analysis_results[user_id] = {
                        "psd_image": psd_b64,
                        "coherence_image": coh_b64,
                        "timestamp": datetime.now().isoformat(),
                        "bad_channels": sorted(bad_channels),
                        "analysis_channels": analysis_channels,
                        "channel_quality": channel_report,
                    }
                if settings.enable_debug_logging:
                    print(f"[{datetime.now():%Y-%m-%d %H:%M:%S}] ユーザー({user_id})の解析結果を更新しました。")
            except Exception as exc:
                print(f"ユーザー({user_id})の解析中にエラーが発生しました: {exc}")


def rabbitmq_consumer() -> None:
    """RabbitMQからデータを受信し、ユーザーごとのバッファに追加するコンシューマスレッド。"""
    zstd_decompressor = zstandard.ZstdDecompressor()
    while True:
        try:
            connection = pika.BlockingConnection(pika.URLParameters(settings.rabbitmq_url))
            channel = connection.channel()
            rabbitmq_connected_event.set()
            channel.exchange_declare(exchange="raw_data_exchange", exchange_type="fanout", durable=True)
            result = channel.queue_declare(queue="", exclusive=True)
            queue_name = result.method.queue
            channel.queue_bind(exchange="raw_data_exchange", queue=queue_name)

            def callback(ch, method, properties, body):
                try:
                    headers = properties.headers or {}
                    user_id = headers.get("user_id")
                    sampling_rate = headers.get("sampling_rate")
                    lsb_to_volts = headers.get("lsb_to_volts")

                    if not (isinstance(user_id, str) and
                            isinstance(sampling_rate, (int, float)) and
                            isinstance(lsb_to_volts, (int, float))):
                        print(f"警告: メッセージヘッダーが不完全または型が不正です: {headers}")
                        ch.basic_ack(delivery_tag=method.delivery_tag)
                        return

                    decompressed = zstd_decompressor.decompress(body)
                    parsed_data = parse_eeg_binary_payload_v4(decompressed)

                    if not parsed_data or parsed_data["signals"].shape[0] == 0:
                        if not parsed_data:
                            print("バイナリデータの解析に失敗しました。")
                        ch.basic_ack(delivery_tag=method.delivery_tag)
                        return

                    header_info = parsed_data["header"]
                    signals = parsed_data["signals"].astype(np.int16, copy=False)
                    impedances = parsed_data["impedance"].astype(np.uint8, copy=False)

                    with buffer_lock:
                        existing_profile = user_device_profiles.get(user_id)
                        sampling_rate_f = float(sampling_rate)
                        needs_reset = (
                            existing_profile is None
                            or existing_profile["ch_names"] != header_info["ch_names"]
                            or existing_profile["ch_types"] != header_info["ch_types"]
                            or abs(existing_profile["sampling_rate"] - sampling_rate_f) > 1e-6
                        )

                        if needs_reset:
                            if existing_profile is not None:
                                print(f"ユーザー({user_id})のチャネル構成が変化したため、プロファイルを再初期化します。")
                            mne_info = mne.create_info(
                                ch_names=header_info["ch_names"],
                                sfreq=sampling_rate_f,
                                ch_types=header_info["ch_types"],
                            )
                            try:
                                mne_info.set_montage("standard_1020", on_missing="warn")
                            except Exception as e:
                                print(f"警告: 電極位置(Montage)の設定に失敗しました。エラー: {e}")

                            user_device_profiles[user_id] = {
                                "ch_names": header_info["ch_names"],
                                "ch_types": header_info["ch_types"],
                                "sampling_rate": sampling_rate_f,
                                "lsb_to_volts": float(lsb_to_volts),
                                "mne_info": mne_info,
                            }
                            user_data_buffers[user_id] = np.empty((0, len(header_info["ch_names"])), dtype=np.int16)
                            channel_quality_trackers[user_id] = ChannelQualityTracker(
                                header_info["ch_names"], header_info["ch_types"]
                            )

                        tracker = channel_quality_trackers.get(user_id)
                        if tracker is None or tracker.num_channels != len(header_info["ch_names"]):
                            tracker = ChannelQualityTracker(header_info["ch_names"], header_info["ch_types"])
                            channel_quality_trackers[user_id] = tracker

                        tracker.update(signals, impedances)
                        bad_channels, channel_report = tracker.build_report()

                        profile = user_device_profiles[user_id]
                        profile["bad_channels"] = bad_channels.copy()
                        profile["channel_report"] = channel_report

                        max_buffer_samples = int(profile['sampling_rate'] * 60) # 60秒分のバッファ

                        current_buffer = user_data_buffers.get(user_id)
                        if current_buffer is None or current_buffer.size == 0:
                            user_data_buffers[user_id] = signals.copy()
                        else:
                            user_data_buffers[user_id] = np.vstack([current_buffer, signals])

                        if user_data_buffers[user_id].shape[0] > max_buffer_samples:
                            user_data_buffers[user_id] = user_data_buffers[user_id][-max_buffer_samples:]

                    ch.basic_ack(delivery_tag=method.delivery_tag)
                except Exception as exc:
                    print(f"RabbitMQコールバックで予期せぬエラー: {exc}")
                    ch.basic_ack(delivery_tag=method.delivery_tag)

            channel.basic_consume(queue=queue_name, on_message_callback=callback)
            print("🚀 リアルタイム解析サービスが起動し、圧縮生データの受信待機中です。")
            channel.start_consuming()
        except pika_exceptions.AMQPConnectionError:
            rabbitmq_connected_event.clear()
            print("RabbitMQへの接続に失敗... 5秒後に再試行します。")
            time.sleep(5)
        except Exception as exc:
            print(f"予期せぬエラーでコンシューマが停止: {exc}。5秒後に再起動します...")
            time.sleep(5)


@app.route("/health", methods=["GET"])
def health_check():
    is_connected = rabbitmq_connected_event.is_set()
    status_code = 200 if is_connected else 503
    status = "ok" if is_connected else "unhealthy"
    return jsonify({"status": status}), status_code


@app.route("/api/v1/users/<user_id>/analysis", methods=["GET"])
def get_analysis_results(user_id: str):
    with analysis_lock:
        user_results = latest_analysis_results.get(user_id)
        if not user_results:
            return jsonify({"status": f"ユーザー({user_id})の解析結果はまだありません..."}), 202
        return jsonify(user_results)


def start_background_threads() -> None:
    global threads_started
    if threads_started:
        return
    threads_started = True
    threading.Thread(target=rabbitmq_consumer, daemon=True).start()
    threading.Thread(target=analysis_worker, daemon=True).start()


def start_realtime_analyzer() -> Flask:
    start_background_threads()
    return app


if __name__ == "__main__":
    print("Flask APIサーバーを http://0.0.0.0:5002 で起動します（開発モード）。")
    app.run(host="0.0.0.0", port=5002)
