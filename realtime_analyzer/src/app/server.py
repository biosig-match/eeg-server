import base64
import io
import struct
import threading
import time
from collections import defaultdict
from datetime import datetime

import matplotlib
import matplotlib.pyplot as plt
import mne
import numpy as np
import pika
import zstandard
from flask import Flask, jsonify
from mne_connectivity import spectral_connectivity_epochs
from mne_connectivity.viz import plot_connectivity_circle

from ..config.env import settings

matplotlib.use("Agg")

NUM_EEG_CHANNELS = 8
CHANNEL_NAMES = ["Fp1", "Fp2", "F7", "F8", "T7", "T8", "P7", "P8"]
HEADER_SIZE = 18
POINT_SIZE = 53
ANALYSIS_WINDOW_SAMPLES = int(settings.sample_rate * settings.analysis_window_seconds)
MAX_BUFFER_SAMPLES = settings.sample_rate * 60

app = Flask(__name__)
latest_analysis_results: dict[str, dict[str, str]] = defaultdict(dict)
user_data_buffers: dict[str, np.ndarray] = defaultdict(lambda: np.array([]))
analysis_lock = threading.Lock()
buffer_lock = threading.Lock()
threads_started = False

mne_info = mne.create_info(ch_names=CHANNEL_NAMES, sfreq=settings.sample_rate, ch_types="eeg")
try:
    mne_info.set_montage("standard_1020", on_missing="warn")
except Exception as exc:  # pragma: no cover - logging purpose only
    if settings.enable_debug_logging:
        print(f"警告: 電極位置(Montage)の設定に失敗しました。エラー: {exc}")


def fig_to_base64(fig) -> str:
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", bbox_inches="tight", pad_inches=0.1)
    plt.close(fig)
    buffer.seek(0)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def analysis_worker() -> None:
    print("✅ 解析ワーカースレッドが起動しました。")
    zstd_sleep = settings.analysis_interval_seconds
    while True:
        time.sleep(zstd_sleep)
        with buffer_lock:
            current_buffers = dict(user_data_buffers)
        for user_id, buffer in current_buffers.items():
            if buffer.shape[0] < ANALYSIS_WINDOW_SAMPLES:
                continue
            data_chunk = buffer[-ANALYSIS_WINDOW_SAMPLES:, :]
            try:
                data_in_volts = (data_chunk.T.astype(np.float64) - 2048.0) * (4.5 / 4096.0) * 1e-6
                raw = mne.io.RawArray(data_in_volts, mne_info, verbose=False)

                fig_psd = raw.compute_psd(
                    fmin=1,
                    fmax=45,
                    n_fft=settings.sample_rate,
                    verbose=False,
                ).plot(show=False, spatial_colors=True)
                psd_b64 = fig_to_base64(fig_psd)

                epochs = mne.make_fixed_length_epochs(
                    raw,
                    duration=settings.analysis_window_seconds,
                    preload=True,
                    verbose=False,
                )
                con = spectral_connectivity_epochs(
                    epochs,
                    method="coh",
                    sfreq=settings.sample_rate,
                    fmin=8,
                    fmax=13,
                    faverage=True,
                    verbose=False,
                )
                con_matrix = np.squeeze(con.get_data(output="dense"))
                fig_coh, _ = plot_connectivity_circle(
                    con_matrix, CHANNEL_NAMES, show=False, vmin=0, vmax=1
                )
                coh_b64 = fig_to_base64(fig_coh)

                with analysis_lock:
                    latest_analysis_results[user_id] = {
                        "psd_image": psd_b64,
                        "coherence_image": coh_b64,
                        "timestamp": datetime.now().isoformat(),
                    }
                if settings.enable_debug_logging:
                    print(
                        f"[{datetime.now():%Y-%m-%d %H:%M:%S}] ユーザー({user_id})の解析結果を更新しました。"
                    )
            except Exception as exc:  # pragma: no cover - logging purpose only
                print(f"ユーザー({user_id})の解析中にエラーが発生しました: {exc}")


def rabbitmq_consumer() -> None:
    zstd_decompressor = zstandard.ZstdDecompressor()
    while True:
        try:
            connection = pika.BlockingConnection(pika.URLParameters(settings.rabbitmq_url))
            channel = connection.channel()
            channel.exchange_declare(
                exchange="raw_data_exchange", exchange_type="fanout", durable=True
            )
            result = channel.queue_declare(queue="", exclusive=True)
            queue_name = result.method.queue
            channel.queue_bind(exchange="raw_data_exchange", queue=queue_name)

            def callback(ch, method, properties, body):
                try:
                    headers = properties.headers or {}
                    user_id = headers.get("user_id")
                    if not user_id:
                        print("警告: user_idがヘッダーに含まれていないメッセージを破棄しました。")
                        ch.basic_ack(delivery_tag=method.delivery_tag)
                        return

                    decompressed = zstd_decompressor.decompress(body)
                    num_points = (len(decompressed) - HEADER_SIZE) // POINT_SIZE
                    if num_points <= 0:
                        ch.basic_ack(delivery_tag=method.delivery_tag)
                        return

                    eeg_samples = []
                    for idx in range(num_points):
                        offset = HEADER_SIZE + (idx * POINT_SIZE)
                        eeg_point = struct.unpack_from(
                            "<" + "H" * NUM_EEG_CHANNELS, decompressed, offset
                        )
                        eeg_samples.append(eeg_point)
                    new_samples = np.array(eeg_samples, dtype=np.uint16)

                    with buffer_lock:
                        current_buffer = user_data_buffers[user_id]
                        if current_buffer.size == 0:
                            user_data_buffers[user_id] = new_samples
                        else:
                            user_data_buffers[user_id] = np.vstack([current_buffer, new_samples])

                        if user_data_buffers[user_id].shape[0] > MAX_BUFFER_SAMPLES:
                            user_data_buffers[user_id] = user_data_buffers[user_id][
                                -MAX_BUFFER_SAMPLES:, :
                            ]

                    ch.basic_ack(delivery_tag=method.delivery_tag)
                except zstandard.ZstdError as exc:
                    print(
                        f"RabbitMQコールバックでZstandard解凍エラー: {exc}。送信データ形式を確認してください。"
                    )
                    ch.basic_ack(delivery_tag=method.delivery_tag)
                except Exception as exc:  # pragma: no cover - logging purpose only
                    print(f"RabbitMQコールバックで予期せぬエラー: {exc}")
                    ch.basic_ack(delivery_tag=method.delivery_tag)

            channel.basic_consume(queue=queue_name, on_message_callback=callback)
            print("🚀 リアルタイム解析サービスが起動し、圧縮生データの受信待機中です。")
            channel.start_consuming()
        except pika.exceptions.AMQPConnectionError:
            print("RabbitMQへの接続に失敗... 5秒後に再試行します。")
            time.sleep(5)
        except Exception as exc:  # pragma: no cover - logging purpose only
            print(f"予期せぬエラーでコンシューマが停止: {exc}。5秒後に再起動します...")
            time.sleep(5)


@app.route("/health", methods=["GET"])
def health_check():
    return jsonify({"status": "ok"})


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


start_background_threads()


def start_realtime_analyzer() -> Flask:
    start_background_threads()
    return app


if __name__ == "__main__":  # pragma: no cover - development only
    print("Flask APIサーバーを http://0.0.0.0:5002 で起動します（開発モード）。")
