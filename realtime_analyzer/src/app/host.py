from __future__ import annotations

import threading
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional

import mne
import numpy as np
import pika
from pika import exceptions as pika_exceptions
import zstandard

from ..config.env import settings
from .applications.base import RealtimeApplication
from .channel_quality import ChannelQualityTracker
from .ingest import parse_eeg_binary_payload_v4
from .state import UserState
from .types import DeviceProfile


class RealtimeApplicationHost:
    """Hosts realtime analysis applications behind a shared collector feed."""

    def __init__(self) -> None:
        self._applications: List[RealtimeApplication] = []
        self._user_states: Dict[str, UserState] = {}
        self._analysis_results: Dict[str, Dict[str, Any]] = defaultdict(dict)
        self._analysis_lock = threading.Lock()
        self._buffer_lock = threading.Lock()
        self._threads_started = False
        self._rabbitmq_connected = threading.Event()

    def register_application(self, application: RealtimeApplication) -> None:
        self._applications.append(application)
        application.on_registered()

    def start_background_threads(self) -> None:
        if self._threads_started:
            return
        self._threads_started = True
        threading.Thread(target=self._rabbitmq_consumer, daemon=True).start()
        threading.Thread(target=self._analysis_worker, daemon=True).start()

    def get_user_results(self, user_id: str) -> Optional[Dict[str, Any]]:
        with self._analysis_lock:
            user_results = self._analysis_results.get(user_id)
            if not user_results:
                return None
            return {
                app_id: dict(result)
                for app_id, result in user_results.items()
            }

    def get_applications_summary(self) -> List[Dict[str, str]]:
        return [
            {
                "id": app.app_id,
                "display_name": app.display_name,
                "description": app.description,
            }
            for app in self._applications
        ]

    def rabbitmq_connected(self) -> bool:
        return self._rabbitmq_connected.is_set()

    def _analysis_worker(self) -> None:
        print("✅ 解析ワーカースレッドが起動しました。")
        while True:
            time.sleep(settings.analysis_interval_seconds)

            for application in self._applications:
                application.before_analysis_cycle()

            with self._buffer_lock:
                snapshot = {
                    user_id: UserState(
                        profile=self._clone_profile(state.profile),
                        buffer=state.buffer.copy(),
                        tracker=state.tracker,
                    )
                    for user_id, state in self._user_states.items()
                }

            for user_id, state in snapshot.items():
                sampling_rate = state.profile["sampling_rate"]
                analysis_samples = int(sampling_rate * settings.analysis_window_seconds)
                if analysis_samples == 0 or state.buffer.shape[0] < analysis_samples:
                    continue

                window = state.buffer[-analysis_samples:, :]

                for application in self._applications:
                    try:
                        result = application.analyze(user_id, state, window)
                        if result is None:
                            continue
                        with self._analysis_lock:
                            self._analysis_results[user_id][application.app_id] = result
                    except Exception as exc:
                        print(
                            f"ユーザー({user_id})のアプリケーション({application.app_id})解析中にエラーが発生しました: {exc}"
                        )

            for application in self._applications:
                application.after_analysis_cycle()

    def _rabbitmq_consumer(self) -> None:
        """Consume raw data from RabbitMQ and update user buffers."""
        zstd_decompressor = zstandard.ZstdDecompressor()
        while True:
            try:
                connection = pika.BlockingConnection(pika.URLParameters(settings.rabbitmq_url))
                channel = connection.channel()
                self._rabbitmq_connected.set()
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

                        if not (
                            isinstance(user_id, str)
                            and isinstance(sampling_rate, (int, float))
                            and isinstance(lsb_to_volts, (int, float))
                        ):
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

                        self._upsert_user_state(
                            user_id=user_id,
                            sampling_rate=float(sampling_rate),
                            lsb_to_volts=float(lsb_to_volts),
                            header_info=header_info,
                            signals=signals,
                            impedances=impedances,
                        )

                        ch.basic_ack(delivery_tag=method.delivery_tag)
                    except Exception as exc:
                        print(f"RabbitMQコールバックで予期せぬエラー: {exc}")
                        ch.basic_ack(delivery_tag=method.delivery_tag)

                channel.basic_consume(queue=queue_name, on_message_callback=callback)
                print("🚀 リアルタイムアプリケーションホストが起動し、圧縮生データの受信待機中です。")
                channel.start_consuming()
            except pika_exceptions.AMQPConnectionError:
                self._rabbitmq_connected.clear()
                print("RabbitMQへの接続に失敗... 5秒後に再試行します。")
                time.sleep(5)
            except Exception as exc:
                self._rabbitmq_connected.clear()
                print(f"予期せぬエラーでコンシューマが停止: {exc}。5秒後に再起動します...")
                time.sleep(5)

    def _upsert_user_state(
        self,
        *,
        user_id: str,
        sampling_rate: float,
        lsb_to_volts: float,
        header_info: Dict[str, List[str]],
        signals: np.ndarray,
        impedances: np.ndarray,
    ) -> None:
        with self._buffer_lock:
            state = self._user_states.get(user_id)
            needs_reset = True
            if state is not None:
                profile = state.profile
                needs_reset = (
                    profile["ch_names"] != header_info["ch_names"]
                    or profile["ch_types"] != header_info["ch_types"]
                    or abs(profile["sampling_rate"] - sampling_rate) > 1e-6
                )

            if needs_reset:
                if state is not None:
                    print(f"ユーザー({user_id})のチャネル構成が変化したため、プロファイルを再初期化します。")

                mne_info = mne.create_info(
                    ch_names=header_info["ch_names"],
                    sfreq=sampling_rate,
                    ch_types=header_info["ch_types"],
                )
                try:
                    mne_info.set_montage("standard_1020", on_missing="warn")
                except Exception as exc:
                    print(f"警告: 電極位置(Montage)の設定に失敗しました。エラー: {exc}")

                profile: DeviceProfile = {
                    "ch_names": header_info["ch_names"],
                    "ch_types": header_info["ch_types"],
                    "sampling_rate": sampling_rate,
                    "lsb_to_volts": lsb_to_volts,
                    "mne_info": mne_info,
                }
                if lsb_to_volts == 0:
                    print(f"[Realtime] Warning: lsb_to_volts is zero for user {user_id}")
                tracker = ChannelQualityTracker(header_info["ch_names"], header_info["ch_types"])
                state = UserState(profile=profile, buffer=np.empty((0, len(header_info["ch_names"])), dtype=np.int16), tracker=tracker)
                self._user_states[user_id] = state
                with self._analysis_lock:
                    self._analysis_results.pop(user_id, None)
                for application in self._applications:
                    application.on_profile_initialized(user_id, state)

            state = self._user_states[user_id]

            tracker = state.tracker
            tracker.update(signals, impedances)
            bad_channels, channel_report = tracker.build_report()
            state.with_updated_quality(bad_channels.copy(), channel_report)

            buffer = state.buffer
            if buffer.size == 0:
                state.buffer = signals.copy()
            else:
                state.buffer = np.vstack([buffer, signals])

            max_buffer_samples = int(state.profile["sampling_rate"] * 60)
            if state.buffer.shape[0] > max_buffer_samples:
                state.buffer = state.buffer[-max_buffer_samples:]

    @staticmethod
    def _clone_profile(profile: DeviceProfile) -> DeviceProfile:
        cloned: DeviceProfile = {
            "ch_names": list(profile["ch_names"]),
            "ch_types": list(profile["ch_types"]),
            "sampling_rate": float(profile["sampling_rate"]),
            "lsb_to_volts": float(profile["lsb_to_volts"]),
            "mne_info": profile["mne_info"],
        }

        if "bad_channels" in profile:
            cloned["bad_channels"] = list(profile["bad_channels"])
        if "channel_report" in profile:
            cloned["channel_report"] = dict(profile["channel_report"])
        return cloned
