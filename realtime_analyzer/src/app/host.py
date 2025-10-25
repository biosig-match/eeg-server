from __future__ import annotations

import copy
import decimal
import errno
import socket
import threading
import time
from collections import defaultdict
from collections.abc import Callable
from typing import Any

import mne
import numpy as np
import pika
import zstandard
from pika import exceptions as pika_exceptions

from ..config.env import settings
from .applications.base import RealtimeApplication
from .channel_quality import ChannelQualityTracker
from .ingest import parse_eeg_binary_payload_v4
from .state import UserState
from .types import DeviceProfile


class RealtimeApplicationHost:
    """Hosts realtime analysis applications behind a shared collector feed."""

    def __init__(self) -> None:
        self._applications: list[RealtimeApplication] = []
        self._user_states: dict[str, UserState] = {}
        self._analysis_results: dict[str, dict[str, Any]] = defaultdict(dict)
        self._analysis_lock = threading.Lock()
        self._buffer_lock = threading.Lock()
        self._threads_started = False
        self._rabbitmq_connected = threading.Event()
        self._thread_guard = threading.Lock()
        self._threads: dict[str, threading.Thread] = {}

    def register_application(self, application: RealtimeApplication) -> None:
        self._applications.append(application)
        application.on_registered()

    def start_background_threads(self) -> None:
        with self._thread_guard:
            if self._threads_started:
                dead_threads = [
                    name for name, thread in self._threads.items() if not thread.is_alive()
                ]
                if not dead_threads:
                    return
                print(f"⚠️ 背景スレッドが停止していたため再起動します: {', '.join(dead_threads)}")
                # 古いスレッドオブジェクトの参照を明示的に削除
                for name in dead_threads:
                    del self._threads[name]
                # デッドスレッドのみを再起動
                if "realtime_rabbitmq_consumer" in dead_threads:
                    self._launch_thread("realtime_rabbitmq_consumer", self._rabbitmq_consumer)
                if "realtime_analysis_worker" in dead_threads:
                    self._launch_thread("realtime_analysis_worker", self._analysis_worker)
                return

            print("🧵 リアルタイム解析の背景スレッドを起動します。")
            self._threads_started = True
            self._threads = {}
            self._launch_thread("realtime_rabbitmq_consumer", self._rabbitmq_consumer)
            self._launch_thread("realtime_analysis_worker", self._analysis_worker)

    def _launch_thread(self, name: str, target: Callable[[], None]) -> None:
        thread = threading.Thread(target=target, name=name, daemon=True)
        thread.start()
        self._threads[name] = thread

    def get_user_results(self, user_id: str) -> dict[str, Any] | None:
        with self._analysis_lock:
            user_results = self._analysis_results.get(user_id)
            if not user_results:
                return None
            return {app_id: copy.deepcopy(result) for app_id, result in user_results.items()}

    def get_applications_summary(self) -> list[dict[str, str]]:
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
        next_analysis_time = time.time() + settings.analysis_interval_seconds

        while True:
            sleep_duration = max(0.0, next_analysis_time - time.time())
            if sleep_duration:
                time.sleep(sleep_duration)
            next_analysis_time += settings.analysis_interval_seconds

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
                            f"ユーザー({user_id})のアプリケーション({application.app_id})解析中にエラーが"
                            f"発生しました: {exc}"
                        )

            for application in self._applications:
                application.after_analysis_cycle()

    def _rabbitmq_consumer(self) -> None:
        """Consume raw data from RabbitMQ and update user buffers."""
        zstd_decompressor = zstandard.ZstdDecompressor()
        while True:
            connection = None
            channel = None
            should_retry = False
            try:
                connection = pika.BlockingConnection(pika.URLParameters(settings.rabbitmq_url))
                channel = connection.channel()
                self._rabbitmq_connected.set()
                channel.exchange_declare(
                    exchange="raw_data_exchange",
                    exchange_type="fanout",
                    durable=True,
                )
                result = channel.queue_declare(queue="", exclusive=True)
                queue_name = result.method.queue
                channel.queue_bind(exchange="raw_data_exchange", queue=queue_name)

                def callback(ch, method, properties, body):
                    try:
                        headers = properties.headers or {}
                        user_id = headers.get("user_id")
                        sampling_rate_value = self._coerce_float(headers.get("sampling_rate"))
                        lsb_to_volts_value = self._coerce_float(
                            headers.get("lsb_to_volts"),
                            headers.get("lsb_to_volts_str"),
                        )

                        if not isinstance(user_id, str) or sampling_rate_value is None:
                            print(f"警告: メッセージヘッダーが不完全または型が不正です: {headers}")
                            ch.basic_ack(delivery_tag=method.delivery_tag)
                            return

                        if lsb_to_volts_value is None:
                            print(
                                "[Realtime] lsb_to_volts ヘッダーを解釈できないため、"
                                f"ユーザー({user_id})のメッセージを除外します。"
                                f"headers={headers}"
                            )
                            ch.basic_ack(delivery_tag=method.delivery_tag)
                            return
                        if lsb_to_volts_value == 0.0:
                            print(
                                "[Realtime] lsb_to_volts=0 のため、ユーザー({user_id})の"
                                f"メッセージを除外します。headers={headers}"
                            )
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
                            sampling_rate=sampling_rate_value,
                            lsb_to_volts=lsb_to_volts_value,
                            header_info=header_info,
                            signals=signals,
                            impedances=impedances,
                        )

                        ch.basic_ack(delivery_tag=method.delivery_tag)
                    except Exception as exc:
                        self._handle_callback_exception(exc, ch, method.delivery_tag)

                channel.basic_consume(queue=queue_name, on_message_callback=callback)
                print(
                    "🚀 リアルタイムアプリケーションホストが起動し、圧縮生データの受信待機中です。"
                )
                channel.start_consuming()
            except pika_exceptions.AMQPConnectionError as exc:
                should_retry = True
                self._rabbitmq_connected.clear()
                print(f"RabbitMQへの接続に失敗: {exc}。5秒後に再試行します。")
            except Exception as exc:
                should_retry = True
                self._rabbitmq_connected.clear()
                print(f"予期せぬエラーでコンシューマが停止: {exc}。5秒後に再起動します...")
            finally:
                if channel is not None and getattr(channel, "is_open", False):
                    try:
                        channel.close()
                    except Exception as close_exc:
                        print(f"チャネルのクローズ中にエラー: {close_exc}")
                if connection is not None and getattr(connection, "is_open", False):
                    try:
                        connection.close()
                    except Exception as close_exc:
                        print(f"接続のクローズ中にエラー: {close_exc}")
                if should_retry:
                    time.sleep(5)

    def _upsert_user_state(
        self,
        *,
        user_id: str,
        sampling_rate: float,
        lsb_to_volts: float,
        header_info: dict[str, list[str]],
        signals: np.ndarray,
        impedances: np.ndarray,
    ) -> None:
        if lsb_to_volts == 0.0:
            print(
                f"[Realtime] lsb_to_voltsが0のためユーザー({user_id})のバッファ"
                "更新をスキップします。"
            )
            return

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
                    print(
                        f"ユーザー({user_id})のチャネル構成が変化したため、"
                        "プロファイルを再初期化します。"
                    )

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
                tracker = ChannelQualityTracker(
                    header_info["ch_names"],
                    header_info["ch_types"],
                )
                state = UserState(
                    profile=profile,
                    buffer=np.empty(
                        (0, len(header_info["ch_names"])),
                        dtype=np.int16,
                    ),
                    tracker=tracker,
                )
                self._user_states[user_id] = state
                with self._analysis_lock:
                    self._analysis_results.pop(user_id, None)
                for application in self._applications:
                    application.on_profile_initialized(user_id, state)

            state = self._user_states[user_id]
            state.profile["lsb_to_volts"] = lsb_to_volts

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
            "mne_info": profile["mne_info"].copy(),
        }

        if "bad_channels" in profile:
            cloned["bad_channels"] = list(profile["bad_channels"])
        if "channel_report" in profile:
            cloned["channel_report"] = copy.deepcopy(profile["channel_report"])
        return cloned

    @staticmethod
    def _coerce_float(*candidates: Any) -> float | None:
        """
        複数の候補から有効な浮動小数点数を抽出する。

        最初の非ゼロ数値を返す。すべてゼロの場合は 0.0 を返す。
        すべて None または変換不可の場合は None を返す。

        この関数は、RabbitMQ ヘッダーの型多様性（int, float, Decimal, str）に対応し、
        lsb_to_volts のゼロ除算を防ぐため、非ゼロ値を優先的に返す。

        Args:
            *candidates: 変換候補（int, float, Decimal, str, None）

        Returns:
            最初の非ゼロ float 値、すべてゼロなら 0.0、すべて無効なら None
        """
        zero_value: float | None = None
        for candidate in candidates:
            if candidate is None:
                continue
            if isinstance(candidate, (int, float)):
                value = float(candidate)
            elif isinstance(candidate, decimal.Decimal):
                value = float(candidate)
            elif isinstance(candidate, str):
                try:
                    value = float(candidate)
                except ValueError:
                    continue
            else:
                continue

            if value != 0.0:
                return value
            zero_value = 0.0
        return zero_value

    @staticmethod
    def _is_transient_error(error: Exception) -> bool:
        if isinstance(
            error,
            (
                pika_exceptions.AMQPConnectionError,
                ConnectionError,
                TimeoutError,
                socket.timeout,
            ),
        ):
            return True

        err_no = getattr(error, "errno", None)
        if err_no in {
            errno.ECONNREFUSED,
            errno.ETIMEDOUT,
            errno.ECONNRESET,
            errno.ENETDOWN,
            errno.ENETUNREACH,
        }:
            return True

        code = getattr(error, "pgcode", None) or getattr(error, "code", None)
        if code in {"08006", "08003", "57P03"}:
            return True

        message = str(error).lower()
        transient_tokens = (
            "timeout",
            "temporarily",
            "connection reset",
            "broken pipe",
            "service unavailable",
            "connection aborted",
        )
        return any(token in message for token in transient_tokens)

    def _handle_callback_exception(self, exc: Exception, ch, delivery_tag) -> None:
        if self._is_transient_error(exc):
            print(f"RabbitMQコールバックで一時的なエラー: {exc}。メッセージを再キューします。")
            ch.basic_nack(delivery_tag=delivery_tag, requeue=True)
        else:
            print(f"RabbitMQコールバックで恒久的なエラー: {exc}。メッセージを破棄します。")
            ch.basic_ack(delivery_tag=delivery_tag)
